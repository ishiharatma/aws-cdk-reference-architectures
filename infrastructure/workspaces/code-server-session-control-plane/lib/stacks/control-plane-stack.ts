import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { Ec2ComputeStack } from 'lib/stacks/ec2-compute-stack';
import { CODE_SERVER_PORT, MicrovmComputeStack, workspaceFunctionName } from 'lib/stacks/microvm-compute-stack';
import { resolveBedrock } from 'lib/shared/claude-bedrock';

/**
 *
 */
interface StackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
  readonly microvm: MicrovmComputeStack;
  readonly ec2?: Ec2ComputeStack;
  /** Connector for running MicroVMs in private mode. @default the AWS-managed internet connector */
  readonly egressConnectorArn?: string;
}

/**
 * The session control plane: Cognito sign-in in front of an HTTP API that starts, reports, suspends,
 * resumes and ends one code-server per user, on a MicroVM or an EC2 instance, and issues the
 * short-lived means of access to the session owner only. IDE traffic never passes through it.
 */
export class ControlPlaneStack extends cdk.Stack {
  public readonly httpApi: apigwv2.IHttpApi;
  public readonly stageName: string;

  /**
   *
   */
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params, microvm, ec2: ec2Compute } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const namePrefix = `${project}-${environment}-code-server-sessions`;
    const microvmParams = params.microvm;
    const controlPlane = params.controlPlane ?? {};
    this.stageName = environment;

    const sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy,
    });
    sessionsTable.addGlobalSecondaryIndex({
      indexName: 'ByOwner',
      partitionKey: { name: 'ownerId', type: dynamodb.AttributeType.STRING },
    });

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${namePrefix}-users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      mfa: controlPlane.requireMfa ? cognito.Mfa.REQUIRED : cognito.Mfa.OFF,
      ...(controlPlane.requireMfa ? { mfaSecondFactor: { otp: true, sms: false } } : {}),
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      removalPolicy,
    });
    // Short-lived, because an issued ID token cannot be revoked and the HTTP API accepts it until it expires.
    const userPoolClient = userPool.addClient('UserPoolClient', {
      authFlows: { userPassword: true, userSrp: true },
      generateSecret: false,
      idTokenValidity: cdk.Duration.minutes(15),
      accessTokenValidity: cdk.Duration.minutes(15),
      // A local relay runs for a working day and must renew without asking for a new MFA code.
      refreshTokenValidity: cdk.Duration.hours(12),
    });

    const workspaceBucket = new s3.Bucket(this, 'WorkspaceBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      autoDeleteObjects: isAutoDeleteObject,
      removalPolicy,
      lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(controlPlane.workspaceVersionDays ?? 14) }],
    });

    const environmentVariables: Record<string, string> = {
      NAME_PREFIX: namePrefix,
      USER_POOL_ID: userPool.userPoolId,
      SESSIONS_TABLE_NAME: sessionsTable.tableName,
      CODE_SERVER_PORT: String(CODE_SERVER_PORT),
      AUTH_TOKEN_MINUTES: String(microvmParams.authTokenMinutes ?? 60),
      MICROVM_IMAGE_ARN: microvm.imageArn,
      MICROVM_EXECUTION_ROLE_ARN: microvm.executionRole.roleArn,
      MICROVM_EGRESS_CONNECTOR_ARN: props.egressConnectorArn ?? microvm.egressConnectorArn,
      MICROVM_LOG_GROUP_NAME: microvm.logGroupName,
      MICROVM_MAX_IDLE_SECONDS: String(microvmParams.maxIdleSeconds ?? 900),
      MICROVM_SUSPENDED_SECONDS: String(microvmParams.suspendedSeconds ?? 3600),
      MICROVM_MAX_DURATION_SECONDS: String(microvmParams.maximumDurationSeconds ?? 28800),
      MAX_ACTIVE_SESSIONS_PER_OWNER: String(controlPlane.maxActiveSessionsPerOwner ?? 2),
      SESSION_RECORD_TTL_DAYS: String(controlPlane.sessionRecordTtlDays ?? 1),
      ...(ec2Compute
        ? {
            EC2_LAUNCH_TEMPLATE_ID: ec2Compute.launchTemplate.launchTemplateId as string,
            EC2_SUBNET_IDS: ec2Compute.subnetIds.join(','),
          }
        : {}),
    };

    const makeFunction = (
      constructId: string, entryFile: string, extraEnv: Record<string, string> = {}, extraProps: Partial<lambdaNodejs.NodejsFunctionProps> = {},
    ): lambdaNodejs.NodejsFunction =>
      new lambdaNodejs.NodejsFunction(this, constructId, {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(__dirname, '..', '..', 'src', 'control-plane', entryFile),
        handler: 'handler',
        timeout: cdk.Duration.seconds(15),
        memorySize: 256,
        environment: { ...environmentVariables, ...extraEnv },
        logGroup: new logs.LogGroup(this, `${constructId}LogGroup`, {
          // These hold the audit trail of who started and opened what.
          retention: logs.RetentionDays.ONE_YEAR,
          removalPolicy,
        }),
        ...extraProps,
      });

    const userLookup = new iam.PolicyStatement({ actions: ['cognito-idp:AdminGetUser'], resources: [userPool.userPoolArn] });

    // IAM authorizes MicroVM actions under the lambda: prefix. The identifiers are minted at
    // RunMicrovm time, so their ARNs are not known ahead of deployment.
    const microvmPolicy = (...actions: string[]): iam.PolicyStatement =>
      new iam.PolicyStatement({ actions: actions.map((a) => `lambda:${a}`), resources: ['*'] });

    // Every action on an instance is limited to instances this control plane tagged at launch.
    const taggedInstances = (...actions: string[]): iam.PolicyStatement =>
      new iam.PolicyStatement({
        actions: actions.map((a) => `ec2:${a}`),
        resources: [this.formatArn({ service: 'ec2', resource: 'instance', resourceName: '*' })],
        conditions: { StringEquals: { 'aws:ResourceTag/CodeServerSessions': namePrefix } },
      });

    const createFn = makeFunction('CreateSessionFunction', 'create-session.ts');
    sessionsTable.grantReadWriteData(createFn);
    createFn.addToRolePolicy(microvmPolicy('RunMicrovm', 'GetMicrovm'));
    createFn.addToRolePolicy(userLookup);
    microvm.executionRole.grantPassRole(createFn.grantPrincipal);
    // RunMicrovm also implicitly attaches the AWS-managed HTTP_INGRESS connector, which needs the same grant.
    createFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:PassNetworkConnector'],
        resources: [
          `arn:${this.partition}:lambda:${this.region}:aws:network-connector:aws-network-connector:*`,
          ...(props.egressConnectorArn ? [props.egressConnectorArn] : []),
        ],
      }),
    );

    const getFn = makeFunction('GetSessionsFunction', 'get-sessions.ts');
    sessionsTable.grantReadWriteData(getFn);
    getFn.addToRolePolicy(microvmPolicy('GetMicrovm'));

    const changeFn = makeFunction('ChangeSessionFunction', 'change-session.ts');
    sessionsTable.grantReadWriteData(changeFn);
    changeFn.addToRolePolicy(microvmPolicy('SuspendMicrovm', 'ResumeMicrovm', 'TerminateMicrovm'));

    const accessFn = makeFunction('AccessSessionFunction', 'access-session.ts');
    sessionsTable.grantReadData(accessFn);
    accessFn.addToRolePolicy(microvmPolicy('CreateMicrovmAuthToken'));
    accessFn.addToRolePolicy(userLookup);

    const workspaceFn = makeFunction('WorkspaceUrlFunction', 'workspace-url.ts', { WORKSPACE_BUCKET_NAME: workspaceBucket.bucketName }, {
      functionName: workspaceFunctionName(namePrefix),
      // The presigner is not part of the Lambda runtime's SDK.
      bundling: { externalModules: [] },
    });
    sessionsTable.grantReadData(workspaceFn);
    workspaceBucket.grantReadWrite(workspaceFn, 'workspaces/*');

    const revokeFn = makeFunction('RevokeUserFunction', 'revoke-user.ts');
    sessionsTable.grantReadWriteData(revokeFn);
    revokeFn.addToRolePolicy(microvmPolicy('TerminateMicrovm'));
    revokeFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminGetUser', 'cognito-idp:AdminDisableUser', 'cognito-idp:AdminUserGlobalSignOut'],
      resources: [userPool.userPoolArn],
    }));

    if (ec2Compute) {
      const describe = new iam.PolicyStatement({ actions: ['ec2:DescribeInstances'], resources: ['*'] });
      const instanceArn = this.formatArn({ service: 'ec2', resource: 'instance', resourceName: '*' });

      createFn.addToRolePolicy(describe);
      getFn.addToRolePolicy(describe);
      createFn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'RunTaggedInstance',
          actions: ['ec2:RunInstances'],
          resources: [instanceArn],
          conditions: { StringEquals: { 'aws:RequestTag/CodeServerSessions': namePrefix } },
        }),
      );
      createFn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'RunFromLaunchTemplate',
          actions: ['ec2:RunInstances'],
          resources: [
            this.formatArn({ service: 'ec2', resource: 'launch-template', resourceName: ec2Compute.launchTemplate.launchTemplateId as string }),
            this.formatArn({ service: 'ec2', resource: 'subnet', resourceName: '*' }),
            this.formatArn({ service: 'ec2', resource: 'security-group', resourceName: '*' }),
            this.formatArn({ service: 'ec2', resource: 'network-interface', resourceName: '*' }),
            this.formatArn({ service: 'ec2', resource: 'volume', resourceName: '*' }),
            `arn:${this.partition}:ec2:${this.region}::image/*`,
          ],
        }),
      );
      // Stack tags propagate into the launch template's tag specifications, so the volume and the
      // network interface are tagged at launch as well as the instance.
      createFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ec2:CreateTags'],
          resources: [
            instanceArn,
            this.formatArn({ service: 'ec2', resource: 'volume', resourceName: '*' }),
            this.formatArn({ service: 'ec2', resource: 'network-interface', resourceName: '*' }),
          ],
          conditions: { StringEquals: { 'ec2:CreateAction': 'RunInstances' } },
        }),
      );
      // The launch template resolves its AMI from a public SSM parameter when it is used.
      createFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameters'],
          resources: [`arn:${this.partition}:ssm:${this.region}::parameter/aws/service/ami-amazon-linux-latest/*`],
        }),
      );
      ec2Compute.instanceRole.grantPassRole(createFn.grantPrincipal);

      changeFn.addToRolePolicy(taggedInstances('StartInstances', 'StopInstances', 'TerminateInstances'));
      revokeFn.addToRolePolicy(taggedInstances('TerminateInstances'));

      accessFn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'PortForwardToTaggedInstance',
          actions: ['ssm:StartSession'],
          resources: [instanceArn],
          conditions: { StringEquals: { 'ssm:resourceTag/CodeServerSessions': namePrefix } },
        }),
      );
      accessFn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'PortForwardDocumentOnly',
          actions: ['ssm:StartSession'],
          resources: [`arn:${this.partition}:ssm:${this.region}::document/AWS-StartPortForwardingSession`],
        }),
      );

      const sweepFn = makeFunction('SweepEc2Function', 'sweep-ec2.ts', {
        EC2_MAX_RUNNING_HOURS: String(params.ec2?.maxRunningHours ?? 8),
      });
      sweepFn.addToRolePolicy(describe);
      sweepFn.addToRolePolicy(taggedInstances('StopInstances', 'TerminateInstances'));
      new events.Rule(this, 'SweepEc2Schedule', {
        description: 'Applies the running and lifetime limits to per-session EC2 instances',
        schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
        targets: [new eventsTargets.LambdaFunction(sweepFn)],
      });
    }

    const portalFn = makeFunction('PortalFunction', 'portal.ts', { USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId });

    const authorizer = new apigwv2Authorizers.HttpUserPoolAuthorizer('SessionsAuthorizer', userPool, {
      userPoolClients: [userPoolClient],
    });
    const accessLogGroup = new logs.LogGroup(this, 'HttpApiAccessLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${namePrefix}-api`,
      description: 'code-server session control plane',
      defaultAuthorizer: authorizer,
      createDefaultStage: false,
    });
    this.httpApi = httpApi;
    const stage = new apigwv2.HttpStage(this, 'HttpApiStage', {
      httpApi,
      stageName: this.stageName,
      autoDeploy: true,
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(accessLogGroup),
        format: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
    });

    const route = (routePath: string, method: apigwv2.HttpMethod, name: string, fn: lambda.IFunction): void => {
      httpApi.addRoutes({
        path: routePath,
        methods: [method],
        integration: new apigwv2Integrations.HttpLambdaIntegration(`${name}Integration`, fn),
      });
    };
    route('/sessions', apigwv2.HttpMethod.POST, 'CreateSession', createFn);
    route('/sessions', apigwv2.HttpMethod.GET, 'ListSessions', getFn);
    route('/sessions/{sessionId}', apigwv2.HttpMethod.GET, 'GetSession', getFn);
    route('/sessions/{sessionId}', apigwv2.HttpMethod.DELETE, 'DeleteSession', changeFn);
    route('/sessions/{sessionId}/suspend', apigwv2.HttpMethod.POST, 'SuspendSession', changeFn);
    route('/sessions/{sessionId}/resume', apigwv2.HttpMethod.POST, 'ResumeSession', changeFn);
    route('/sessions/{sessionId}/access', apigwv2.HttpMethod.POST, 'AccessSession', accessFn);
    httpApi.addRoutes({
      path: '/portal',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration('PortalIntegration', portalFn),
      authorizer: new apigwv2.HttpNoneAuthorizer(),
    });

    this.addOperations(namePrefix, project, params, [createFn, accessFn, workspaceFn, revokeFn], createFn, removalPolicy);

    new cdk.CfnOutput(this, 'RevokeUserFunctionName', { value: revokeFn.functionName });
    new cdk.CfnOutput(this, 'WorkspaceBucketName', { value: workspaceBucket.bucketName });
    new cdk.CfnOutput(this, 'ApiUrl', { value: stage.url as string });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
  }

  /**
   * Alarms on what a user would notice first, or what costs money without anyone noticing.
   */
  private addOperations(
    namePrefix: string, project: string, params: EnvParams, functions: lambda.IFunction[], createFn: lambdaNodejs.NodejsFunction, removalPolicy: cdk.RemovalPolicy,
  ): void {
    const operations = params.operations;
    if (!operations) return;

    const topicKey = new kms.Key(this, 'AlarmTopicKey', { description: 'Encrypts the alarm topic', enableKeyRotation: true, removalPolicy });
    topicKey.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
      resources: ['*'],
    }));
    const topic = new sns.Topic(this, 'AlarmTopic', { topicName: `${namePrefix}-alarms`, masterKey: topicKey, enforceSSL: true });
    if (operations.alarmEmail) topic.addSubscription(new subscriptions.EmailSubscription(operations.alarmEmail));
    const action = new cwActions.SnsAction(topic);

    const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, description: string): void => {
      new cloudwatch.Alarm(this, `${id}Alarm`, {
        alarmName: `${namePrefix}-${id}`,
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(action);
    };

    functions.forEach((fn, index) => {
      alarm(`FunctionErrors${index}`, fn.metricErrors({ period: cdk.Duration.minutes(5) }), 1, 'A control plane function failed; users may be unable to start or open sessions');
    });

    // The account's MicroVM memory quota caps concurrent sessions; hitting it blocks new ones.
    const quotaMetric = new logs.MetricFilter(this, 'CapacityErrorsFilter', {
      logGroup: createFn.logGroup,
      metricNamespace: namePrefix,
      metricName: 'CapacityErrors',
      filterPattern: logs.FilterPattern.anyTerm('ServiceQuotaExceededException', 'InsufficientInstanceCapacity'),
      metricValue: '1',
      defaultValue: 0,
    }).metric({ statistic: 'Sum', period: cdk.Duration.minutes(5) });
    alarm('CapacityErrors', quotaMetric, 1, 'New sessions are refused for lack of capacity; check the MicroVM memory quota');

    const { modelId } = resolveBedrock(params.bedrock);
    const tokens = (metricName: string): cloudwatch.Metric => new cloudwatch.Metric({
      namespace: 'AWS/Bedrock',
      metricName,
      dimensionsMap: { ModelId: modelId },
      statistic: 'Sum',
      period: cdk.Duration.days(1),
    });
    alarm('BedrockDailyTokens', new cloudwatch.MathExpression({
      expression: 'input + output',
      usingMetrics: { input: tokens('InputTokenCount'), output: tokens('OutputTokenCount') },
      period: cdk.Duration.days(1),
      label: 'Bedrock tokens per day',
    }), operations.dailyBedrockTokenLimit ?? 5_000_000, 'Bedrock use is unusually high; every user can call the model from a terminal, with no per-user limit');

    if (operations.monthlyBudgetUsd && operations.alarmEmail) {
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: `${namePrefix}-monthly`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: operations.monthlyBudgetUsd, unit: 'USD' },
          // Requires the "Project" cost allocation tag to be activated in Billing.
          costFilters: { TagKeyValue: [`user:Project$${project}`] },
        },
        notificationsWithSubscribers: [80, 100].map((threshold) => ({
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL', address: operations.alarmEmail as string }],
        })),
      });
    }
  }
}
