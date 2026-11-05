import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { Ec2ComputeStack } from 'lib/stacks/ec2-compute-stack';
import { CODE_SERVER_PORT, MicrovmComputeStack } from 'lib/stacks/microvm-compute-stack';

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
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      removalPolicy,
    });
    const userPoolClient = userPool.addClient('UserPoolClient', {
      authFlows: { userPassword: true, userSrp: true },
      generateSecret: false,
    });

    const environmentVariables: Record<string, string> = {
      NAME_PREFIX: namePrefix,
      SESSIONS_TABLE_NAME: sessionsTable.tableName,
      CODE_SERVER_PORT: String(CODE_SERVER_PORT),
      AUTH_TOKEN_MINUTES: String(microvmParams.authTokenMinutes ?? 60),
      MICROVM_IMAGE_ARN: microvm.imageArn,
      MICROVM_EXECUTION_ROLE_ARN: microvm.executionRole.roleArn,
      MICROVM_EGRESS_CONNECTOR_ARN: microvm.egressConnectorArn,
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

    const makeFunction = (constructId: string, entryFile: string, extraEnv: Record<string, string> = {}): lambdaNodejs.NodejsFunction =>
      new lambdaNodejs.NodejsFunction(this, constructId, {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(__dirname, '..', '..', 'src', 'control-plane', entryFile),
        handler: 'handler',
        timeout: cdk.Duration.seconds(15),
        memorySize: 256,
        environment: { ...environmentVariables, ...extraEnv },
        logGroup: new logs.LogGroup(this, `${constructId}LogGroup`, {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy,
        }),
      });

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
    microvm.executionRole.grantPassRole(createFn.grantPrincipal);
    // RunMicrovm also implicitly attaches the AWS-managed HTTP_INGRESS connector, which needs the same grant.
    createFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:PassNetworkConnector'],
        resources: [`arn:${this.partition}:lambda:${this.region}:aws:network-connector:aws-network-connector:*`],
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

    new cdk.CfnOutput(this, 'ApiUrl', { value: stage.url as string });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
  }
}
