import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { DemoWebUi } from '../constructs/demo-web-ui';
import { STATUS_INDEX_NAME } from '../../src/shared/types';

/** Properties for {@link LambdaDurableFunctionsApprovalStack}. */
export interface LambdaDurableFunctionsApprovalStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/**
 * Human-in-the-loop approval workflow on Lambda durable functions.
 *
 *   Client --IAM--> API Gateway
 *     POST /requests                  -> StartRequest  --async invoke (live alias, execution name)--> Workflow (durable)
 *     POST /requests/{id}/decision    -> SubmitDecision --SendDurableExecutionCallbackSuccess------> Workflow resumes
 *     GET  /requests/{id}             -> GetRequest    -> DynamoDB (status projection)
 *     GET  /requests?status=          -> ListRequests  -> DynamoDB status GSI (approvers' work list)
 *
 *   Workflow: register -> waitForCallback (SNS to approvers, up to N hours, no compute) -> fulfill / reject / expire
 *   Ops: EventBridge "Durable Execution Status Change" (FAILED/TIMED_OUT/STOPPED) + DLQ -> alert topic
 */
export class LambdaDurableFunctionsApprovalStack extends cdk.Stack {
  /** The durable workflow function (unqualified; invoke it through {@link workflowAlias}). */
  public readonly workflowFunction: lambda.IFunction;
  /** `live` alias that new executions start on. */
  public readonly workflowAlias: lambda.IAlias;
  /** IAM-authorized REST API. */
  public readonly api: apigateway.IRestApi;
  /** Demo web UI, when `demoWebUi.enabled`. */
  public readonly demoWebUi?: DemoWebUi;

  /** Creates the approval workflow resources. */
  constructor(scope: Construct, id: string, props: LambdaDurableFunctionsApprovalStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const namePrefix = `${project}-${environment}-ldf`;
    const srcDir = path.join(__dirname, '..', '..', 'src');

    if (params.workflow.executionTimeoutDays * 24 * 60 <= params.workflow.approvalTimeoutMinutes) {
      throw new Error(
        'workflow.executionTimeoutDays must be longer than workflow.approvalTimeoutMinutes'
      );
    }

    // ---- Status projection ---------------------------------------------------
    const requestsTable = new dynamodb.Table(this, 'RequestsTable', {
      tableName: `${namePrefix}-requests`,
      partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });
    // The approvers' work list. Demo-scale: one partition per status value.
    requestsTable.addGlobalSecondaryIndex({
      indexName: STATUS_INDEX_NAME,
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ---- Notifications -------------------------------------------------------
    // A customer managed key, because EventBridge and CloudWatch alarms cannot publish to
    // topics encrypted with the AWS managed aws/sns key.
    const topicKey = new kms.Key(this, 'TopicKey', {
      alias: `alias/${namePrefix}-topics`,
      description: `${namePrefix} SNS topic encryption`,
      enableKeyRotation: true,
      removalPolicy,
    });
    for (const service of ['events.amazonaws.com', 'cloudwatch.amazonaws.com']) {
      topicKey.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal(service)],
          actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
          resources: ['*'],
          conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
        })
      );
    }

    const approvalTopic = new sns.Topic(this, 'ApprovalTopic', {
      topicName: `${namePrefix}-approval-requests`,
      masterKey: topicKey,
      enforceSSL: true,
    });
    params.approverEmails?.forEach((email) =>
      approvalTopic.addSubscription(new subscriptions.EmailSubscription(email))
    );

    const alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: `${namePrefix}-alerts`,
      masterKey: topicKey,
      enforceSSL: true,
    });
    params.alertEmails?.forEach((email) =>
      alertTopic.addSubscription(new subscriptions.EmailSubscription(email))
    );

    // ---- Durable workflow function --------------------------------------------
    // Lambda does not retry a failed durable execution started asynchronously; the DLQ keeps
    // the original event of every execution that ends FAILED, STOPPED or TIMED_OUT.
    const workflowDlq = new sqs.Queue(this, 'WorkflowDlq', {
      queueName: `${namePrefix}-workflow-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy,
    });

    const commonProps = {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      bundling: { minify: true },
    } satisfies Partial<lambdaNodejs.NodejsFunctionProps>;
    // The durable execution APIs (DurableExecutionName, SendDurableExecutionCallbackSuccess) need a
    // recent @aws-sdk/client-lambda; bundle it instead of relying on the runtime-provided SDK version.
    const bundleAwsSdk = { ...commonProps.bundling, bundleAwsSDK: true };

    const makeLogGroup = (idPrefix: string): logs.LogGroup =>
      new logs.LogGroup(this, `${idPrefix}LogGroup`, {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy,
      });

    const workflowFunction = new lambdaNodejs.NodejsFunction(this, 'WorkflowFunction', {
      ...commonProps,
      functionName: `${namePrefix}-approval-workflow`,
      description: 'Durable approval workflow (invoke through the live alias only)',
      entry: path.join(srcDir, 'handlers', 'approval-workflow.ts'),
      handler: 'handler',
      // Per invocation. Waiting for the approver suspends the function and does not count.
      timeout: cdk.Duration.seconds(params.workflow.invocationTimeoutSeconds),
      durableConfig: {
        executionTimeout: cdk.Duration.days(params.workflow.executionTimeoutDays),
        retentionPeriod: cdk.Duration.days(params.workflow.retentionDays),
      },
      deadLetterQueue: workflowDlq,
      environment: {
        TABLE_NAME: requestsTable.tableName,
        APPROVAL_TOPIC_ARN: approvalTopic.topicArn,
        APPROVAL_TIMEOUT_MINUTES: String(params.workflow.approvalTimeoutMinutes),
      },
      // An execution resumes on the version it started on, possibly days later. Keep old
      // versions when a deploy publishes a new one, or their in-flight executions break.
      currentVersionOptions: { removalPolicy: cdk.RemovalPolicy.RETAIN },
      logGroup: makeLogGroup('Workflow'),
    });
    this.workflowFunction = workflowFunction;
    requestsTable.grants.readWriteData(workflowFunction);
    approvalTopic.grants.publish(workflowFunction);

    this.workflowAlias = new lambda.Alias(this, 'WorkflowLiveAlias', {
      aliasName: 'live',
      version: workflowFunction.currentVersion,
      description: 'New executions start on the version this alias points to',
    });

    // ---- API handlers --------------------------------------------------------
    const startRequestFn = new lambdaNodejs.NodejsFunction(this, 'StartRequestFunction', {
      ...commonProps,
      functionName: `${namePrefix}-start-request`,
      entry: path.join(srcDir, 'handlers', 'start-request.ts'),
      handler: 'handler',
      bundling: bundleAwsSdk,
      timeout: cdk.Duration.seconds(10),
      environment: {
        WORKFLOW_FUNCTION_ARN: this.workflowAlias.functionArn,
        TABLE_NAME: requestsTable.tableName,
      },
      logGroup: makeLogGroup('StartRequest'),
    });
    this.workflowAlias.grantInvoke(startRequestFn);
    // Read-only: detects a reused Idempotency-Key before invoking (the workflow owns all writes).
    requestsTable.grants.readData(startRequestFn);

    const submitDecisionFn = new lambdaNodejs.NodejsFunction(this, 'SubmitDecisionFunction', {
      ...commonProps,
      functionName: `${namePrefix}-submit-decision`,
      entry: path.join(srcDir, 'handlers', 'submit-decision.ts'),
      handler: 'handler',
      bundling: bundleAwsSdk,
      timeout: cdk.Duration.seconds(10),
      environment: { TABLE_NAME: requestsTable.tableName },
      logGroup: makeLogGroup('SubmitDecision'),
    });
    requestsTable.grants.readWriteData(submitDecisionFn);
    // Callback APIs are authorized against the durable execution ARN
    // (<function-arn>:<version>/durable-execution/...), so the unqualified function ARN never matches.
    submitDecisionFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:SendDurableExecutionCallbackSuccess'],
        resources: [`${this.workflowFunction.functionArn}:*`],
      })
    );

    const getRequestFn = new lambdaNodejs.NodejsFunction(this, 'GetRequestFunction', {
      ...commonProps,
      functionName: `${namePrefix}-get-request`,
      entry: path.join(srcDir, 'handlers', 'get-request.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      environment: { TABLE_NAME: requestsTable.tableName },
      logGroup: makeLogGroup('GetRequest'),
    });
    requestsTable.grants.readData(getRequestFn);

    const listRequestsFn = new lambdaNodejs.NodejsFunction(this, 'ListRequestsFunction', {
      ...commonProps,
      functionName: `${namePrefix}-list-requests`,
      entry: path.join(srcDir, 'handlers', 'list-requests.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      environment: { TABLE_NAME: requestsTable.tableName },
      logGroup: makeLogGroup('ListRequests'),
    });
    requestsTable.grants.readData(listRequestsFn);

    // ---- REST API (IAM auth) ---------------------------------------------------
    const accessLogGroup = makeLogGroup('ApiAccess');
    const api = new apigateway.RestApi(this, 'RequestsApi', {
      restApiName: `${namePrefix}-requests-api`,
      description: 'Approval requests API backed by a Lambda durable function',
      cloudWatchRole: true,
      cloudWatchRoleRemovalPolicy: removalPolicy,
      defaultMethodOptions: { authorizationType: apigateway.AuthorizationType.IAM },
      deployOptions: {
        stageName: environment,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
        throttlingRateLimit: params.apiThrottle.rateLimit,
        throttlingBurstLimit: params.apiThrottle.burstLimit,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
    });

    this.api = api;
    const bodyValidator = api.addRequestValidator('BodyValidator', {
      requestValidatorName: 'validate-body',
      validateRequestBody: true,
      validateRequestParameters: true,
    });
    const createRequestModel = api.addModel('CreateRequestModel', {
      contentType: 'application/json',
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        required: ['title', 'amount'],
        additionalProperties: false,
        properties: {
          title: { type: apigateway.JsonSchemaType.STRING, minLength: 1, maxLength: 200 },
          amount: { type: apigateway.JsonSchemaType.NUMBER, exclusiveMinimum: true, minimum: 0 },
        },
      },
    });
    const decisionModel = api.addModel('DecisionModel', {
      contentType: 'application/json',
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        required: ['approved'],
        additionalProperties: false,
        properties: {
          approved: { type: apigateway.JsonSchemaType.BOOLEAN },
          comment: { type: apigateway.JsonSchemaType.STRING, maxLength: 1000 },
        },
      },
    });

    const requests = api.root.addResource('requests');
    requests.addMethod('GET', new apigateway.LambdaIntegration(listRequestsFn), {
      requestValidator: bodyValidator,
      requestParameters: { 'method.request.querystring.status': false },
    });
    requests.addMethod('POST', new apigateway.LambdaIntegration(startRequestFn), {
      requestValidator: bodyValidator,
      requestModels: { 'application/json': createRequestModel },
      requestParameters: { 'method.request.header.Idempotency-Key': false },
    });
    const request = requests.addResource('{requestId}');
    request.addMethod('GET', new apigateway.LambdaIntegration(getRequestFn), {
      requestValidator: bodyValidator,
    });
    const decision = request.addResource('decision');
    decision.addMethod('POST', new apigateway.LambdaIntegration(submitDecisionFn), {
      requestValidator: bodyValidator,
      requestModels: { 'application/json': decisionModel },
    });

    // ---- Demo web UI (optional) ------------------------------------------------------
    if (params.demoWebUi?.enabled) {
      const demo = new DemoWebUi(this, 'DemoWebUi', {
        namePrefix,
        api,
        approvalTimeoutMinutes: params.workflow.approvalTimeoutMinutes,
        cognitoDomainPrefix:
          params.demoWebUi.cognitoDomainPrefix ?? `${namePrefix}-${this.account}`,
        removalPolicy,
        autoDeleteObjects: isAutoDeleteObject,
      });
      this.demoWebUi = demo;

      // CORS for the UI origin only. Preflight (OPTIONS) is unauthenticated by design; the
      // actual calls stay IAM-authorized.
      const corsOptions: apigateway.CorsOptions = {
        allowOrigins: [demo.origin],
        allowHeaders: [
          ...apigateway.Cors.DEFAULT_HEADERS,
          'X-Amz-Content-Sha256',
          'Idempotency-Key',
        ],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        maxAge: cdk.Duration.hours(1),
      };
      [requests, request, decision].forEach((resource) => resource.addCorsPreflight(corsOptions));
      // IAM denials (403) and validation errors (400) are produced by API Gateway, not by a
      // handler; without these headers the browser hides them as network errors.
      for (const [id, type] of [
        ['Cors4xx', apigateway.ResponseType.DEFAULT_4XX],
        ['Cors5xx', apigateway.ResponseType.DEFAULT_5XX],
      ] as const) {
        api.addGatewayResponse(id, {
          type,
          responseHeaders: {
            'Access-Control-Allow-Origin': `'${demo.origin}'`,
            Vary: "'Origin'",
          },
        });
      }
      [startRequestFn, submitDecisionFn, getRequestFn, listRequestsFn].forEach((fn) =>
        fn.addEnvironment('CORS_ALLOW_ORIGIN', demo.origin)
      );
    }

    // ---- Operations ------------------------------------------------------------
    // The trailing ':' keeps the prefix from also matching e.g. "<name>-v2".
    new events.Rule(this, 'WorkflowFailedRule', {
      ruleName: `${namePrefix}-workflow-failed`,
      description: 'Durable executions of the approval workflow that ended abnormally',
      eventPattern: {
        source: ['aws.lambda'],
        detailType: ['Durable Execution Status Change'],
        detail: {
          status: ['FAILED', 'TIMED_OUT', 'STOPPED'],
          functionArn: events.Match.prefix(`${this.workflowFunction.functionArn}:`),
        },
      },
      targets: [new targets.SnsTopic(alertTopic)],
    });

    new cloudwatch.Alarm(this, 'WorkflowDlqAlarm', {
      alarmName: `${namePrefix}-workflow-dlq-not-empty`,
      alarmDescription: 'Original events of failed durable executions are waiting in the DLQ',
      metric: workflowDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cwActions.SnsAction(alertTopic));

    // ---- Outputs ---------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'REST API base URL (IAM auth)',
    });
    new cdk.CfnOutput(this, 'WorkflowFunctionName', { value: this.workflowFunction.functionName });
    new cdk.CfnOutput(this, 'WorkflowAliasArn', {
      value: this.workflowAlias.functionArn,
      description: 'Qualified ARN used to start executions',
    });
    new cdk.CfnOutput(this, 'RequestsTableName', { value: requestsTable.tableName });
    new cdk.CfnOutput(this, 'WorkflowDlqUrl', { value: workflowDlq.queueUrl });
  }
}
