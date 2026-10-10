import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as budgets from 'aws-cdk-lib/aws-budgets';
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
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { InspectedEgress } from 'lib/constructs/inspected-egress';

export interface ClaudeManagedAgentsLambdaMicrovmsStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly envParams: EnvParams;
}

const HOOK_PORT = 9000;
const METRIC_NAMESPACE = 'ClaudeManagedAgents';

/**
 * Claude Managed Agents self-hosted sandboxes on AWS Lambda MicroVMs (event-driven webhook model).
 *
 *   Anthropic --webhook--> WAF -> API Gateway -> launcher Lambda --RunMicrovm--> one MicroVM per session
 *   MicroVM worker --pull--> Anthropic work queue (tool calls run inside the MicroVM)
 *   worker --TerminateMicrovm--> itself when the session ends
 *
 * Secrets are split by reader: the launcher reads only the webhook signing secret, the MicroVM only the
 * environment key. The organization API key never reaches AWS compute.
 */
export class ClaudeManagedAgentsLambdaMicrovmsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ClaudeManagedAgentsLambdaMicrovmsStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, envParams } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const prefix = `${project}-${environment}-claude`;
    const logRetention = (envParams.operations?.logRetentionDays ?? 30) as logs.RetentionDays;
    const network = envParams.network ?? {};
    const egressMode = network.egressMode ?? 'internet';
    const ingressMode = network.ingressMode ?? 'all';
    const image = envParams.microvm;
    const maxLifetimeSeconds = image.maxLifetimeSeconds ?? 14400;
    const idlePolicy = {
      maxIdleDurationSeconds: image.idlePolicy?.maxIdleDurationSeconds ?? 600,
      suspendedDurationSeconds: image.idlePolicy?.suspendedDurationSeconds ?? 0,
      autoResumeEnabled: image.idlePolicy?.autoResumeEnabled ?? false,
    };

    // ---------------------------------------------------------------------------------------------
    // Secrets: SecureString parameters are written after deploy (scripts/put-secrets.sh). The stack
    // only owns their names, the KMS key (optional) and the read permissions.
    // ---------------------------------------------------------------------------------------------
    const environmentKeyParamName = envParams.secrets?.environmentKeyParamName ?? `/${project}/${environment}/anthropic/environment-key`;
    const signingParamName = envParams.secrets?.signingParamName ?? `/${project}/${environment}/anthropic/webhook-signing-secret`;
    const parameterArn = (name: string) => `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${name}`;

    const secretsKey = envParams.secrets?.useCustomerManagedKey
      ? new kms.Key(this, 'SecretsKey', {
        alias: `alias/${prefix}-secrets`,
        description: 'Encrypts the Anthropic environment key and webhook signing secret (SSM SecureString)',
        enableKeyRotation: true,
        removalPolicy,
      })
      : undefined;

    /** Read one SecureString: ssm:GetParameter on its ARN, kms:Decrypt bounded to that parameter. */
    const grantReadSecret = (grantee: iam.IGrantable, paramName: string) => {
      iam.Grant.addToPrincipal({
        grantee,
        actions: ['ssm:GetParameter'],
        resourceArns: [parameterArn(paramName)],
      });
      iam.Grant.addToPrincipal({
        grantee,
        actions: ['kms:Decrypt'],
        resourceArns: [secretsKey?.keyArn ?? '*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': `ssm.${this.region}.amazonaws.com`,
            'kms:EncryptionContext:PARAMETER_ARN': parameterArn(paramName),
          },
        },
      });
    };

    // ---------------------------------------------------------------------------------------------
    // Network connectors
    // ---------------------------------------------------------------------------------------------
    const managedConnector = (name: string) =>
      `arn:${this.partition}:lambda:${this.region}:aws:network-connector:aws-network-connector:${name}`;
    const ingressConnectorArn = managedConnector(ingressMode === 'all' ? 'ALL_INGRESS' : 'NO_INGRESS');
    const internetEgressArn = managedConnector('INTERNET_EGRESS');

    let egressConnectorArn = internetEgressArn;
    let inspectedEgress: InspectedEgress | undefined;
    if (egressMode === 'firewall') {
      inspectedEgress = new InspectedEgress(this, 'InspectedEgress', {
        prefix,
        vpcCidr: network.vpcCidr ?? '10.60.0.0/24',
        allowedDomains: network.allowedDomains ?? ['api.anthropic.com', '.amazonaws.com'],
        logRetention,
        removalPolicy,
      });
      egressConnectorArn = inspectedEgress.connector.attrArn;
    }

    // ---------------------------------------------------------------------------------------------
    // MicroVM image: Dockerfile + worker, built by the service from an S3 asset
    // ---------------------------------------------------------------------------------------------
    const servicePrincipal = new iam.ServicePrincipal('lambda.amazonaws.com');
    const imageAsset = new s3assets.Asset(this, 'MicrovmImageAsset', {
      path: path.join(__dirname, '..', '..', 'src', 'microvm-image'),
    });

    const microvmLogGroup = new logs.LogGroup(this, 'MicrovmLogGroup', {
      logGroupName: `/aws/lambda-microvms/${prefix}-worker`,
      retention: logRetention,
      removalPolicy,
    });

    const buildRole = new iam.Role(this, 'MicrovmImageBuildRole', {
      assumedBy: servicePrincipal,
      description: 'Assumed by Lambda MicroVMs while building the worker image',
    });
    imageAsset.bucket.grantRead(buildRole);
    // Without this grant a failed build leaves no log stream at all.
    microvmLogGroup.grants.write(buildRole);

    // Assumed inside each running MicroVM. It reads the environment key and ends the MicroVM itself.
    const executionRole = new iam.Role(this, 'MicrovmExecutionRole', {
      assumedBy: servicePrincipal,
      description: 'Assumed by running worker MicroVMs: read the environment key, terminate itself',
    });
    // The reference implementation's trust policy also allows sts:TagSession.
    executionRole.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
      principals: [servicePrincipal],
      actions: ['sts:TagSession'],
    }));
    grantReadSecret(executionRole, environmentKeyParamName);
    microvmLogGroup.grants.write(executionRole);
    // MicroVM IDs are assigned at run time, so the resource cannot be narrowed ahead of time.
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:TerminateMicrovm'],
      resources: ['*'],
    }));

    const microvmImage = new lambda.CfnMicrovmImage(this, 'WorkerImage', {
      name: `${prefix}-worker`,
      description: 'Claude self-hosted environment worker (EnvironmentWorker) packaged as a Lambda MicroVM image',
      baseImageArn: image.baseImageArn,
      baseImageVersion: image.baseImageVersion,
      buildRoleArn: buildRole.roleArn,
      codeArtifact: { uri: imageAsset.s3ObjectUrl },
      cpuConfigurations: [{ architecture: image.architecture ?? 'ARM_64' }],
      // The build needs the package registry; the runtime connectors are chosen per RunMicrovm call.
      egressNetworkConnectors: [internetEgressArn],
      hooks: {
        microvmImageHooks: { ready: 'ENABLED', readyTimeoutInSeconds: 300, validate: 'ENABLED', validateTimeoutInSeconds: 300 },
        // A /run hook that times out terminates the MicroVM at once; the worker answers 200 first.
        microvmHooks: {
          run: 'ENABLED', runTimeoutInSeconds: 5,
          suspend: 'ENABLED', suspendTimeoutInSeconds: 5,
          resume: 'ENABLED', resumeTimeoutInSeconds: 5,
          terminate: 'ENABLED', terminateTimeoutInSeconds: 5,
        },
        port: HOOK_PORT,
      },
      logging: { cloudWatch: { logGroup: microvmLogGroup.logGroupName } },
      resources: [{ minimumMemoryInMiB: image.minimumMemoryInMiB ?? 2048 }],
      environmentVariables: [],
      additionalOsCapabilities: [],
    });
    // The role's policies must exist before the build starts.
    microvmImage.node.addDependency(buildRole);

    // ---------------------------------------------------------------------------------------------
    // Launcher: webhook -> RunMicrovm
    // ---------------------------------------------------------------------------------------------
    const idempotencyTtlSeconds = maxLifetimeSeconds;
    const idempotencyTable = new dynamodb.Table(this, 'IdempotencyTable', {
      tableName: `${prefix}-idempotency`,
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiration',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    const launcher = new lambdaNodejs.NodejsFunction(this, 'LauncherFunction', {
      functionName: `${prefix}-launcher`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '..', '..', 'src', 'launcher', 'index.ts'),
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      // Bundle the AWS SDK: the MicroVMs client is newer than the SDK in the Lambda runtime.
      bundling: { externalModules: [], minify: true, sourceMap: false },
      environment: {
        ANTHROPIC_ENVIRONMENT_ID: envParams.anthropic.environmentId,
        ...(envParams.anthropic.baseUrl ? { ANTHROPIC_BASE_URL: envParams.anthropic.baseUrl } : {}),
        MICROVM_IMAGE_ARN: microvmImage.attrImageArn,
        MICROVM_EXECUTION_ROLE_ARN: executionRole.roleArn,
        MICROVM_LOG_GROUP: microvmLogGroup.logGroupName,
        ENVIRONMENT_KEY_PARAM_NAME: environmentKeyParamName,
        SIGNING_PARAM_NAME: signingParamName,
        IDEMPOTENCY_TABLE: idempotencyTable.tableName,
        IDEMPOTENCY_TTL_SECONDS: String(idempotencyTtlSeconds),
        INGRESS_CONNECTOR_ARN: ingressConnectorArn,
        EGRESS_CONNECTOR_ARN: egressConnectorArn,
        IDLE_POLICY: JSON.stringify(idlePolicy),
        MAX_LIFETIME_SECONDS: String(maxLifetimeSeconds),
      },
      logGroup: new logs.LogGroup(this, 'LauncherLogGroup', { retention: logRetention, removalPolicy }),
    });
    grantReadSecret(launcher, signingParamName);
    idempotencyTable.grant(launcher, 'dynamodb:PutItem', 'dynamodb:DeleteItem');
    launcher.addToRolePolicy(new iam.PolicyStatement({ actions: ['lambda:RunMicrovm'], resources: ['*'] }));
    executionRole.grants.passRole(launcher.grantPrincipal);
    launcher.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:PassNetworkConnector'],
      resources: [
        // RunMicrovm also attaches an AWS-managed HTTP_INGRESS connector implicitly.
        managedConnector('*'),
        ...(inspectedEgress ? [inspectedEgress.connector.attrArn] : []),
      ],
    }));

    // ---------------------------------------------------------------------------------------------
    // Webhook entry: REST API + request validation + WAF
    // ---------------------------------------------------------------------------------------------
    const apiAccessLogs = new logs.LogGroup(this, 'ApiAccessLogs', { retention: logRetention, removalPolicy });
    const api = new apigateway.RestApi(this, 'WebhookApi', {
      restApiName: `${prefix}-webhook`,
      description: 'Receives Anthropic webhooks; the launcher verifies the signature',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      cloudWatchRole: false,
      deployOptions: {
        stageName: 'prod',
        tracingEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(apiAccessLogs),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        metricsEnabled: true,
      },
    });
    const webhookModel = api.addModel('AnthropicWebhookEvent', {
      contentType: 'application/json',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        type: apigateway.JsonSchemaType.OBJECT,
        required: ['type', 'id', 'created_at', 'data'],
        properties: {
          type: { type: apigateway.JsonSchemaType.STRING },
          id: { type: apigateway.JsonSchemaType.STRING },
          created_at: { type: apigateway.JsonSchemaType.STRING },
          data: {
            type: apigateway.JsonSchemaType.OBJECT,
            required: ['type', 'id'],
            properties: {
              type: { type: apigateway.JsonSchemaType.STRING },
              id: { type: apigateway.JsonSchemaType.STRING },
            },
          },
        },
      },
    });
    // Request hygiene only: the HMAC check in the launcher is what authenticates the sender.
    api.root.addResource('webhook').addMethod('POST', new apigateway.LambdaIntegration(launcher), {
      requestValidator: api.addRequestValidator('BodyValidator', { validateRequestBody: true }),
      requestModels: { 'application/json': webhookModel },
    });

    const managedRule = (name: string, priority: number): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
      visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: `${prefix}-${name}` },
    });
    const webAcl = new wafv2.CfnWebACL(this, 'WebhookWebAcl', {
      name: `${prefix}-webhook`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: `${prefix}-webhook` },
      rules: [
        managedRule('AWSManagedRulesCommonRuleSet', 1),
        managedRule('AWSManagedRulesKnownBadInputsRuleSet', 2),
        managedRule('AWSManagedRulesAmazonIpReputationList', 3),
        {
          name: 'RateLimitPerIp',
          priority: 4,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 100, evaluationWindowSec: 300, aggregateKeyType: 'IP' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: `${prefix}-rate-limit` },
        },
      ],
    });
    const wafLogs = new logs.LogGroup(this, 'WafLogs', {
      logGroupName: `aws-waf-logs-${prefix}-webhook`,
      retention: logRetention,
      removalPolicy,
    });
    const wafAssociation = new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: api.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn,
    });
    wafAssociation.node.addDependency(api.deploymentStage);
    new wafv2.CfnLoggingConfiguration(this, 'WafLogging', {
      resourceArn: webAcl.attrArn,
      logDestinationConfigs: [wafLogs.logGroupArn],
    });

    // ---------------------------------------------------------------------------------------------
    // Operations: alarms, stale MicroVM detection, budget
    // ---------------------------------------------------------------------------------------------
    const alarmKey = new kms.Key(this, 'AlarmTopicKey', {
      description: 'Encrypts the alarm topic',
      enableKeyRotation: true,
      removalPolicy,
    });
    alarmKey.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com'), new iam.ServicePrincipal('budgets.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
      resources: ['*'],
    }));
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${prefix}-alarms`,
      masterKey: alarmKey,
      enforceSSL: true,
    });
    const alarmEmail = envParams.operations?.alarmEmail;
    if (alarmEmail) alarmTopic.addSubscription(new subscriptions.EmailSubscription(alarmEmail));
    const alarmAction = new cwActions.SnsAction(alarmTopic);

    const metricFilter = (filterId: string, metricName: string, pattern: logs.IFilterPattern) => {
      new logs.MetricFilter(this, filterId, {
        logGroup: launcher.logGroup,
        metricNamespace: METRIC_NAMESPACE,
        metricName,
        filterPattern: pattern,
        metricValue: '1',
        defaultValue: 0,
      });
      return new cloudwatch.Metric({ namespace: METRIC_NAMESPACE, metricName, statistic: 'Sum', period: cdk.Duration.minutes(5) });
    };
    const rejected = metricFilter('WebhookRejectedFilter', 'WebhookRejected', logs.FilterPattern.literal('"webhook signature verification failed"'));
    const runFailed = metricFilter('RunMicrovmFailedFilter', 'RunMicrovmFailed', logs.FilterPattern.literal('"RunMicrovm failed"'));
    const capacity = metricFilter('RunMicrovmCapacityFilter', 'RunMicrovmCapacityErrors',
      logs.FilterPattern.anyTerm('ServiceQuotaExceededException', 'ThrottlingException'));

    const alarm = (alarmId: string, metric: cloudwatch.IMetric, description: string) => {
      const a = new cloudwatch.Alarm(this, alarmId, {
        alarmName: `${prefix}-${alarmId}`,
        alarmDescription: description,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(alarmAction);
      return a;
    };
    alarm('LauncherErrors', launcher.metricErrors({ period: cdk.Duration.minutes(5) }), 'The launcher Lambda raised an unhandled error');
    alarm('WebhookRejected', rejected, 'Webhook deliveries failed signature verification (HTTP 401): check the signing secret in SSM');
    alarm('RunMicrovmFailed', runFailed, 'RunMicrovm failed; Anthropic retries the delivery');
    alarm('RunMicrovmCapacity', capacity, 'MicroVM quota or throttling limit reached: request a limit increase');

    const staleDetector = new lambdaNodejs.NodejsFunction(this, 'StaleDetectorFunction', {
      functionName: `${prefix}-stale-detector`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '..', '..', 'src', 'stale-detector', 'index.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      bundling: { externalModules: [], minify: true, sourceMap: false },
      environment: {
        MICROVM_IMAGE_ARN: microvmImage.attrImageArn,
        STALE_THRESHOLD_MINUTES: String(envParams.operations?.staleThresholdMinutes ?? 240),
        METRIC_NAMESPACE,
      },
      logGroup: new logs.LogGroup(this, 'StaleDetectorLogGroup', { retention: logRetention, removalPolicy }),
    });
    staleDetector.addToRolePolicy(new iam.PolicyStatement({ actions: ['lambda:ListMicrovms'], resources: ['*'] }));
    staleDetector.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': METRIC_NAMESPACE } },
    }));
    new events.Rule(this, 'StaleDetectorSchedule', {
      description: 'Looks for worker MicroVMs that outlived the expected session length',
      schedule: events.Schedule.rate(cdk.Duration.minutes(10)),
      targets: [new targets.LambdaFunction(staleDetector)],
    });
    alarm('StaleMicrovms', new cloudwatch.Metric({
      namespace: METRIC_NAMESPACE, metricName: 'StaleMicrovms', statistic: 'Maximum', period: cdk.Duration.minutes(10),
    }), 'A worker MicroVM is still RUNNING past the stale threshold: self-termination was missed');

    if (envParams.operations?.monthlyBudgetUsd && alarmEmail) {
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: `${prefix}-monthly`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: envParams.operations.monthlyBudgetUsd, unit: 'USD' },
          // Requires the "Project" cost allocation tag to be activated in Billing.
          costFilters: { TagKeyValue: [`user:Project$${project}`] },
        },
        notificationsWithSubscribers: [80, 100].map((threshold) => ({
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: alarmEmail }],
        })),
      });
    }

    // ---------------------------------------------------------------------------------------------
    // Outputs (used by scripts/*.sh)
    // ---------------------------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'WebhookUrl', { value: `${api.url}webhook` });
    new cdk.CfnOutput(this, 'EnvironmentKeyParamName', { value: environmentKeyParamName });
    new cdk.CfnOutput(this, 'SigningParamName', { value: signingParamName });
    new cdk.CfnOutput(this, 'SecretsKeyAlias', { value: secretsKey ? `alias/${prefix}-secrets` : 'alias/aws/ssm' });
    new cdk.CfnOutput(this, 'MicrovmImageArn', { value: microvmImage.attrImageArn });
    new cdk.CfnOutput(this, 'MicrovmLogGroupName', { value: microvmLogGroup.logGroupName });
    new cdk.CfnOutput(this, 'LauncherFunctionName', { value: launcher.functionName });
    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: alarmTopic.topicArn });
    new cdk.CfnOutput(this, 'EgressMode', { value: egressMode });
    new cdk.CfnOutput(this, 'IngressConnectorArn', { value: ingressConnectorArn });
    new cdk.CfnOutput(this, 'EgressConnectorArn', { value: egressConnectorArn });
    if (inspectedEgress) {
      new cdk.CfnOutput(this, 'FirewallAlertLogGroup', { value: inspectedEgress.alertLogGroup.logGroupName });
      new cdk.CfnOutput(this, 'FirewallFlowLogGroup', { value: inspectedEgress.flowLogGroup.logGroupName });
    }
  }
}
