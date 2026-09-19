import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { defaultControlPlaneConfig, defaultMicrovmImageConfig } from 'lib/types';

interface StackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/**
 * Serverless Codex App Server on AWS Lambda MicroVMs.
 *
 * A session control plane (API Gateway HTTP API + 5 Lambda functions) calls
 * the Lambda MicroVMs data-plane API to launch, on demand, a VM-isolated
 * MicroVM running `codex app-server` (OpenAI Codex CLI's JSON-RPC agent
 * protocol). Clients connect *directly* to the MicroVM's dedicated HTTPS
 * endpoint for the Thread/Turn/Item traffic -- the control plane only
 * brokers session lifecycle (start / status / suspend / resume / end), it
 * never proxies app-server messages itself.
 */
export class LambdaMicrovmsCodexAppserverStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const namePrefix = `${project}-${environment}-codex`;

    const microvmImageParams = params.microvmImage;
    const controlPlaneParams = params.controlPlane ?? {};

    const appServerPort = 8080;

    // ------------------------------------------------------------------
    // Networking: a VPC egress path so MicroVMs can reach the OpenAI API.
    // AWS::Lambda::NetworkConnector is how a MicroVM image's
    // egressNetworkConnectors attach to a VPC's NAT-backed subnets; without
    // one, MicroVMs have no outbound network access at all.
    // ------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'microvm-egress', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    const egressSecurityGroup = new ec2.SecurityGroup(this, 'MicrovmEgressSecurityGroup', {
      vpc,
      description: 'Outbound-only security group for Codex App Server MicroVMs (HTTPS to the OpenAI API)',
      allowAllOutbound: true,
    });

    const egressNetworkConnector = new lambda.CfnNetworkConnector(this, 'MicrovmEgressConnector', {
      name: `${namePrefix}-egress`,
      configuration: {
        vpcEgressConfiguration: {
          associatedComputeResourceTypes: ['MicroVm'],
          subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
          securityGroupIds: [egressSecurityGroup.securityGroupId],
          networkProtocol: 'IPv4',
        },
      },
    });

    // ------------------------------------------------------------------
    // Secret: the OpenAI API key codex app-server authenticates with.
    // Baked into the image as a *reference* (environmentVariables carries
    // only the secret's ARN); the value itself is fetched inside the
    // MicroVM at `run` time via the execution role (see
    // src/microvm-image/hooks/run.sh). Update the placeholder value after
    // the first deploy.
    // ------------------------------------------------------------------
    const openAiApiKeySecret = new secretsmanager.Secret(this, 'OpenAiApiKeySecret', {
      secretName: `${namePrefix}-openai-api-key`,
      description: 'OpenAI API key used by codex app-server inside the MicroVM. Replace the placeholder after deploying.',
      removalPolicy,
    });

    // ------------------------------------------------------------------
    // MicroVM image: Dockerfile + lifecycle hooks packaged as a CDK asset.
    // ------------------------------------------------------------------
    const microvmImageAsset = new s3assets.Asset(this, 'MicrovmImageAsset', {
      path: path.join(__dirname, '..', '..', 'src', 'microvm-image'),
    });

    // NOTE: the exact service principal Lambda MicroVMs uses to assume the
    // build/execution roles is not yet documented in a stable, citable
    // form as of this reference's authoring. `lambda.amazonaws.com` is
    // used here to mirror how Lambda's own execution roles are trusted;
    // verify against the current AWS Lambda MicroVMs Developer Guide
    // before deploying to a real account (see README.md "IAM trust
    // policy" note).
    const microvmServicePrincipal = new iam.ServicePrincipal('lambda.amazonaws.com');

    const buildRole = new iam.Role(this, 'MicrovmImageBuildRole', {
      assumedBy: microvmServicePrincipal,
      description: 'Assumed by Lambda MicroVMs while building the codex app-server image (create-microvm-image)',
    });
    microvmImageAsset.bucket.grantRead(buildRole);

    const executionRole = new iam.Role(this, 'MicrovmExecutionRole', {
      assumedBy: microvmServicePrincipal,
      description: 'Assumed by running codex app-server MicroVMs to read the OpenAI API key secret',
    });
    openAiApiKeySecret.grantRead(executionRole);

    const microvmImageLogGroup = new logs.LogGroup(this, 'MicrovmImageLogGroup', {
      logGroupName: `/lambda-microvms/${namePrefix}-image`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });

    const microvmImage = new lambda.CfnMicrovmImage(this, 'CodexAppServerImage', {
      name: microvmImageParams.name ?? `${namePrefix}-image`,
      description: 'codex app-server (OpenAI Codex CLI, JSON-RPC over WebSocket) packaged as a Lambda MicroVM image',
      baseImageArn: microvmImageParams.baseImageArn,
      baseImageVersion: microvmImageParams.baseImageVersion,
      buildRoleArn: buildRole.roleArn,
      codeArtifact: {
        uri: microvmImageAsset.s3ObjectUrl,
      },
      cpuConfigurations: [{ architecture: microvmImageParams.architecture ?? defaultMicrovmImageConfig.architecture }],
      egressNetworkConnectors: [egressNetworkConnector.attrArn],
      environmentVariables: [{ key: 'OPENAI_API_KEY_SECRET_ARN', value: openAiApiKeySecret.secretArn }],
      // Each hook field is an ENABLED/DISABLED switch, not a path: the
      // CloudFormation resource schema for AWS::Lambda::MicrovmImage rejects
      // a literal script path here (confirmed via `cdk synth`'s
      // CloudFormation Validate plugin). Enabling a hook makes the platform
      // invoke that hook's well-known executable inside the image; the
      // exact conventional path per hook is not yet confirmed against a
      // citable AWS source as of this reference's authoring, so the scripts
      // are placed at the plausible convention `/opt/hooks/<hook>.sh` (see
      // src/microvm-image/Dockerfile) -- verify against the current AWS
      // Lambda MicroVMs Developer Guide before deploying, and adjust the
      // Dockerfile's script location if it documents a different path.
      hooks: {
        microvmHooks: {
          run: 'ENABLED',
          runTimeoutInSeconds: 30,
          suspend: 'ENABLED',
          suspendTimeoutInSeconds: 15,
          resume: 'ENABLED',
          resumeTimeoutInSeconds: 15,
          terminate: 'ENABLED',
          terminateTimeoutInSeconds: 15,
        },
        microvmImageHooks: {
          ready: 'ENABLED',
          readyTimeoutInSeconds: 60,
          validate: 'ENABLED',
          validateTimeoutInSeconds: 60,
        },
        port: appServerPort,
      },
      logging: {
        cloudWatch: { logGroup: microvmImageLogGroup.logGroupName },
      },
      resources: [
        { minimumMemoryInMiB: microvmImageParams.minimumMemoryInMiB ?? defaultMicrovmImageConfig.minimumMemoryInMiB },
      ],
      additionalOsCapabilities: microvmImageParams.additionalOsCapabilities ?? defaultMicrovmImageConfig.additionalOsCapabilities,
    });
    microvmImage.node.addDependency(egressNetworkConnector);

    // ------------------------------------------------------------------
    // Session store: one record per Codex session, owner-scoped.
    // ------------------------------------------------------------------
    const sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      tableName: `${namePrefix}-sessions`,
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy,
    });

    // ------------------------------------------------------------------
    // Auth: Cognito user pool backs the control plane's JWT authorizer.
    // ------------------------------------------------------------------
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

    // ------------------------------------------------------------------
    // Control plane: session lifecycle Lambdas behind an HTTP API.
    // ------------------------------------------------------------------
    const commonEnvironment: Record<string, string> = {
      SESSIONS_TABLE_NAME: sessionsTable.tableName,
      MICROVM_IMAGE_ARN: microvmImage.attrImageArn,
      MICROVM_EXECUTION_ROLE_ARN: executionRole.roleArn,
      EGRESS_NETWORK_CONNECTORS: egressNetworkConnector.attrArn,
      CODEX_APP_SERVER_PORT: String(appServerPort),
      MAX_SESSION_DURATION_MINUTES: String(
        controlPlaneParams.maxSessionDurationInMinutes ?? defaultControlPlaneConfig.maxSessionDurationInMinutes,
      ),
      IDLE_TIMEOUT_MINUTES: String(controlPlaneParams.idleTimeoutInMinutes ?? defaultControlPlaneConfig.idleTimeoutInMinutes),
      SUSPENDED_DURATION_MINUTES: String(
        controlPlaneParams.suspendedDurationInMinutes ?? defaultControlPlaneConfig.suspendedDurationInMinutes,
      ),
      AUTO_RESUME_ENABLED: String(controlPlaneParams.autoResumeEnabled ?? defaultControlPlaneConfig.autoResumeEnabled),
      AUTH_TOKEN_EXPIRATION_MINUTES: String(
        controlPlaneParams.authTokenExpirationInMinutes ?? defaultControlPlaneConfig.authTokenExpirationInMinutes,
      ),
      SESSION_RECORD_TTL_DAYS: String(
        controlPlaneParams.sessionRecordTtlInDays ?? defaultControlPlaneConfig.sessionRecordTtlInDays,
      ),
    };

    // MicroVM data-plane actions operate on MicroVM/image identifiers
    // minted at RunMicrovm time, so their resource ARNs cannot be known
    // ahead of deployment; scoped to '*' and suppressed in
    // test/compliance/cdk-nag.test.ts with that rationale.
    const microvmDataPlanePolicy = new iam.PolicyStatement({
      sid: 'LambdaMicrovmsDataPlane',
      actions: [
        'lambda-microvms:RunMicrovm',
        'lambda-microvms:GetMicrovm',
        'lambda-microvms:TerminateMicrovm',
        'lambda-microvms:SuspendMicrovm',
        'lambda-microvms:ResumeMicrovm',
        'lambda-microvms:CreateMicrovmAuthToken',
      ],
      resources: ['*'],
    });

    const controlPlaneFunctions: lambdaNodejs.NodejsFunction[] = [];
    const makeControlPlaneFunction = (constructId: string, entryFile: string): lambdaNodejs.NodejsFunction => {
      const fn = new lambdaNodejs.NodejsFunction(this, constructId, {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: `src/control-plane/${entryFile}`,
        handler: 'handler',
        timeout: cdk.Duration.seconds(15),
        memorySize: 256,
        environment: commonEnvironment,
        logGroup: new logs.LogGroup(this, `${constructId}LogGroup`, {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy,
        }),
      });
      sessionsTable.grantReadWriteData(fn);
      fn.addToRolePolicy(microvmDataPlanePolicy);
      controlPlaneFunctions.push(fn);
      return fn;
    };

    const createSessionFn = makeControlPlaneFunction('CreateSessionFunction', 'create-session.ts');
    // RunMicrovmRequest.executionRoleArn requires the caller to be able to
    // pass that role to the Lambda MicroVMs service.
    executionRole.grantPassRole(createSessionFn.grantPrincipal);

    const getSessionFn = makeControlPlaneFunction('GetSessionFunction', 'get-session.ts');
    const deleteSessionFn = makeControlPlaneFunction('DeleteSessionFunction', 'delete-session.ts');
    const suspendSessionFn = makeControlPlaneFunction('SuspendSessionFunction', 'suspend-session.ts');
    const resumeSessionFn = makeControlPlaneFunction('ResumeSessionFunction', 'resume-session.ts');

    const authorizer = new apigwv2Authorizers.HttpUserPoolAuthorizer('SessionsAuthorizer', userPool, {
      userPoolClients: [userPoolClient],
    });

    const accessLogGroup = new logs.LogGroup(this, 'HttpApiAccessLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${namePrefix}-api`,
      description: 'Codex App Server session control plane (start / status / suspend / resume / end)',
      defaultAuthorizer: authorizer,
      createDefaultStage: false,
    });

    const stage = new apigwv2.HttpStage(this, 'HttpApiStage', {
      httpApi,
      stageName: environment,
      autoDeploy: true,
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(accessLogGroup),
        format: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
    });

    httpApi.addRoutes({
      path: '/sessions',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration('CreateSessionIntegration', createSessionFn),
    });
    httpApi.addRoutes({
      path: '/sessions/{sessionId}',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration('GetSessionIntegration', getSessionFn),
    });
    httpApi.addRoutes({
      path: '/sessions/{sessionId}',
      methods: [apigwv2.HttpMethod.DELETE],
      integration: new apigwv2Integrations.HttpLambdaIntegration('DeleteSessionIntegration', deleteSessionFn),
    });
    httpApi.addRoutes({
      path: '/sessions/{sessionId}/suspend',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration('SuspendSessionIntegration', suspendSessionFn),
    });
    httpApi.addRoutes({
      path: '/sessions/{sessionId}/resume',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration('ResumeSessionIntegration', resumeSessionFn),
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: stage.url,
      description: 'Codex session control-plane API URL',
    });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'MicrovmImageArn', { value: microvmImage.attrImageArn });
    new cdk.CfnOutput(this, 'SessionsTableName', { value: sessionsTable.tableName });
    new cdk.CfnOutput(this, 'OpenAiApiKeySecretArn', {
      value: openAiApiKeySecret.secretArn,
      description: 'Update this secret with a real OpenAI API key after the first deploy',
    });
  }
}
