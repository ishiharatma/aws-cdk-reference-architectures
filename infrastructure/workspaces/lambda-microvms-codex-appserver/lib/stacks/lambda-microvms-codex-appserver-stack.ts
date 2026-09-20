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
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
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
 * Modeled on the "Lambda MicroVMsで実現するServerlessなCodex App Server"
 * architecture (Japan Digital Design, Inc., 2026-09-15).
 *
 * A session control plane (an HTTP API with 7 Lambda functions, plus a
 * WebSocket API with 3 more) calls the Lambda MicroVMs data-plane API to
 * launch, on demand, a VM-isolated MicroVM running `codex app-server`
 * (OpenAI Codex CLI's JSON-RPC agent protocol). Lambda MicroVMs has no
 * built-in way to log into a running MicroVM and stream a command's
 * response back, so each MicroVM runs its own HTTP server
 * (src/microvm-image/server/) that (a) answers the platform's lifecycle
 * hook calls, (b) relays JSON-RPC requests from clients to the
 * `codex app-server` child process it manages, and (c) captures every line
 * codex app-server emits via an in-VM Event Handler that persists it to
 * the EventsTable below. Clients connect *directly* to the MicroVM's
 * dedicated HTTPS endpoint to drive a Turn, but read output through the
 * control plane rather than the MicroVM: EventsTable is the durable source
 * of truth (readable via GET .../events after the MicroVM is SUSPENDED or
 * terminated), and a DynamoDB Streams-triggered forward-event Lambda also
 * pushes each new event over the WebSocket API in near-real-time to
 * whichever connections are watching that session, so a client is not
 * limited to polling. The control plane itself only ever brokers session
 * lifecycle and output delivery; it never proxies app-server *input*
 * traffic.
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
    // Events: every codex app-server JSON-RPC line, captured in-VM and
    // persisted here by the Event Handler (src/microvm-image/server/
    // event-handler.mjs) so a session's Thread/Turn content survives the
    // MicroVM being SUSPENDED or terminated. get-session.ts polls this
    // table independently of the MicroVM's own lifecycle.
    // ------------------------------------------------------------------
    const eventsTable = new dynamodb.Table(this, 'EventsTable', {
      tableName: `${namePrefix}-events`,
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sequence', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy,
      // Consumed by forward-event.ts to push new codex app-server output
      // to connected WebSocket clients in near-real-time, in addition to
      // (not instead of) get-events's pull-based polling read path.
      stream: dynamodb.StreamViewType.NEW_IMAGE,
    });

    // ------------------------------------------------------------------
    // WebSocket connections: which client connections are watching which
    // session, so forward-event.ts knows where to push new events. The
    // ByConnectionId GSI lets ws-disconnect.ts look up a connection's
    // session using only the connectionId API Gateway hands it.
    // ------------------------------------------------------------------
    const connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
      tableName: `${namePrefix}-connections`,
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy,
    });
    connectionsTable.addGlobalSecondaryIndex({
      indexName: 'ByConnectionId',
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
    });

    // ------------------------------------------------------------------
    // Secret: the OpenAI API key codex app-server authenticates with.
    // Baked into the image as a *reference* (environmentVariables carries
    // only the secret's ARN); the value itself is fetched inside the
    // MicroVM at container-start time via the execution role (see
    // src/microvm-image/server/secret.mjs). Update the placeholder value
    // after the first deploy.
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
    // The in-VM Event Handler writes every codex app-server output line
    // here directly using this role's injected credentials.
    eventsTable.grantWriteData(executionRole);

    const microvmImageLogGroup = new logs.LogGroup(this, 'MicrovmImageLogGroup', {
      logGroupName: `/lambda-microvms/${namePrefix}-image`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });

    const microvmImage = new lambda.CfnMicrovmImage(this, 'CodexAppServerImage', {
      name: microvmImageParams.name ?? `${namePrefix}-image`,
      description: 'codex app-server (OpenAI Codex CLI) + an in-VM HTTP relay/event-handler, packaged as a Lambda MicroVM image',
      baseImageArn: microvmImageParams.baseImageArn,
      baseImageVersion: microvmImageParams.baseImageVersion,
      buildRoleArn: buildRole.roleArn,
      codeArtifact: {
        uri: microvmImageAsset.s3ObjectUrl,
      },
      cpuConfigurations: [{ architecture: microvmImageParams.architecture ?? defaultMicrovmImageConfig.architecture }],
      egressNetworkConnectors: [egressNetworkConnector.attrArn],
      environmentVariables: [
        { key: 'OPENAI_API_KEY_SECRET_ARN', value: openAiApiKeySecret.secretArn },
        { key: 'EVENTS_TABLE_NAME', value: eventsTable.tableName },
      ],
      // Each hook field is an ENABLED/DISABLED switch, not a path: the
      // CloudFormation resource schema for AWS::Lambda::MicrovmImage rejects
      // a literal script path here (confirmed via `cdk synth`'s
      // CloudFormation Validate plugin). This matches the source
      // architecture: enabling a hook makes the platform call that
      // lifecycle event as an HTTP request against the in-VM server on
      // `Hooks.port` (GET /ready before the build snapshot is taken; POST
      // /run with RunMicrovmRequest.runHookPayload as the body once a
      // session's MicroVM launches; POST /suspend, /resume, /terminate at
      // the corresponding transitions) -- see src/microvm-image/server/.
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
      EVENTS_TABLE_NAME: eventsTable.tableName,
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

    // get-events polls the Events table (written by the in-VM Event
    // Handler) instead of calling the MicroVM data plane, so it keeps
    // working after a session's MicroVM is SUSPENDED or terminated.
    const getEventsFn = makeControlPlaneFunction('GetEventsFunction', 'get-events.ts');
    eventsTable.grantReadData(getEventsFn);

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
    httpApi.addRoutes({
      path: '/sessions/{sessionId}/events',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration('GetEventsIntegration', getEventsFn),
    });

    // ------------------------------------------------------------------
    // WebSocket API: near-real-time push of EventsTable writes to clients,
    // in addition to (not instead of) get-events's pull-based polling.
    // ------------------------------------------------------------------
    const wsAuthorizerFn = new lambdaNodejs.NodejsFunction(this, 'WsAuthorizerFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: 'src/control-plane/ws-authorizer.ts',
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
      },
      logGroup: new logs.LogGroup(this, 'WsAuthorizerFunctionLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy,
      }),
    });

    const wsConnectFn = new lambdaNodejs.NodejsFunction(this, 'WsConnectFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: 'src/control-plane/ws-connect.ts',
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        SESSIONS_TABLE_NAME: sessionsTable.tableName,
        CONNECTIONS_TABLE_NAME: connectionsTable.tableName,
      },
      logGroup: new logs.LogGroup(this, 'WsConnectFunctionLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy,
      }),
    });
    sessionsTable.grantReadData(wsConnectFn);
    connectionsTable.grantWriteData(wsConnectFn);

    const wsDisconnectFn = new lambdaNodejs.NodejsFunction(this, 'WsDisconnectFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: 'src/control-plane/ws-disconnect.ts',
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        CONNECTIONS_TABLE_NAME: connectionsTable.tableName,
      },
      logGroup: new logs.LogGroup(this, 'WsDisconnectFunctionLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy,
      }),
    });
    connectionsTable.grantReadWriteData(wsDisconnectFn);

    const webSocketApi = new apigwv2.WebSocketApi(this, 'WebSocketApi', {
      apiName: `${namePrefix}-events-ws`,
      description: 'Near-real-time push of codex app-server output (EventsTable writes) to connected clients',
      connectRouteOptions: {
        integration: new apigwv2Integrations.WebSocketLambdaIntegration('WsConnectIntegration', wsConnectFn),
        // A Cognito ID token cannot ride a WebSocket handshake's
        // Authorization header from a browser, so it travels as a `token`
        // query string parameter instead (see ws-authorizer.ts).
        authorizer: new apigwv2Authorizers.WebSocketLambdaAuthorizer('WsConnectAuthorizer', wsAuthorizerFn, {
          identitySource: ['route.request.querystring.token'],
        }),
      },
      disconnectRouteOptions: {
        integration: new apigwv2Integrations.WebSocketLambdaIntegration('WsDisconnectIntegration', wsDisconnectFn),
      },
    });

    const webSocketStage = new apigwv2.WebSocketStage(this, 'WebSocketApiStage', {
      webSocketApi,
      stageName: environment,
      autoDeploy: true,
    });

    const forwardEventFn = new lambdaNodejs.NodejsFunction(this, 'ForwardEventFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: 'src/control-plane/forward-event.ts',
      handler: 'handler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        CONNECTIONS_TABLE_NAME: connectionsTable.tableName,
        WEBSOCKET_CALLBACK_URL: webSocketStage.callbackUrl,
      },
      logGroup: new logs.LogGroup(this, 'ForwardEventFunctionLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy,
      }),
    });
    connectionsTable.grantReadWriteData(forwardEventFn);
    webSocketStage.grantManagementApiAccess(forwardEventFn);
    forwardEventFn.addEventSource(
      new lambdaEventSources.DynamoEventSource(eventsTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 3,
      }),
    );

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: stage.url,
      description: 'Codex session control-plane API URL',
    });
    new cdk.CfnOutput(this, 'WebSocketUrl', {
      value: webSocketStage.url,
      description: 'Connect with ?sessionId=...&token=<Cognito ID token> to receive near-real-time session events',
    });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'MicrovmImageArn', { value: microvmImage.attrImageArn });
    new cdk.CfnOutput(this, 'SessionsTableName', { value: sessionsTable.tableName });
    new cdk.CfnOutput(this, 'EventsTableName', { value: eventsTable.tableName });
    new cdk.CfnOutput(this, 'OpenAiApiKeySecretArn', {
      value: openAiApiKeySecret.secretArn,
      description: 'Update this secret with a real OpenAI API key after the first deploy',
    });
  }
}
