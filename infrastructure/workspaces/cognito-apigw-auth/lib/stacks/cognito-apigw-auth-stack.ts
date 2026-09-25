import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

export interface CognitoApigwAuthStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/**
 * Authentication and authorization for a REST API with Amazon Cognito.
 *
 *   authentication  Cognito user pool (users, MFA option, groups) issues JWTs
 *   authorization   API Gateway Cognito authorizer verifies the JWT (signature, issuer, client, expiry)
 *                   and, per method, the OAuth scopes of a resource server; the Lambda then applies
 *                   what only it can: group membership and per-user data isolation
 *
 *   GET  /me      any signed-in user            ID token
 *   GET  /notes   scope notes/read              access token (user or machine)
 *   POST /notes   scope notes/write             access token (user)
 *   GET  /admin   group `admin`                 ID token
 */
export class CognitoApigwAuthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CognitoApigwAuthStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const namePrefix = `${project}-${environment}-authdemo`;

    // ---------------------------------------------------------------------------------------------
    // Cognito user pool
    // ---------------------------------------------------------------------------------------------
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${namePrefix}-users`,
      selfSignUpEnabled: false, // users are created by an administrator; open sign-up is a product decision
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(3),
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false }, // TOTP only: no SMS cost, no SIM-swap exposure
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: !isAutoDeleteObject,
      removalPolicy,
    });

    // Groups travel in the ID token as `cognito:groups`.
    new cognito.UserPoolGroup(this, 'AdminGroup', { userPool, groupName: 'admin', description: 'Can call /admin' });
    new cognito.UserPoolGroup(this, 'MemberGroup', { userPool, groupName: 'member', description: 'Regular users' });

    // Resource server: defines the OAuth scopes the API understands (`notes/read`, `notes/write`).
    const readScope = new cognito.ResourceServerScope({ scopeName: 'read', scopeDescription: 'Read notes' });
    const writeScope = new cognito.ResourceServerScope({ scopeName: 'write', scopeDescription: 'Create notes' });
    const resourceServer = userPool.addResourceServer('NotesResourceServer', {
      identifier: 'notes',
      userPoolResourceServerName: `${namePrefix}-notes`,
      scopes: [readScope, writeScope],
    });

    // Interactive clients: public client (no secret), authorization code + PKCE, or direct sign-in for tests.
    const webClient = userPool.addClient('WebClient', {
      userPoolClientName: `${namePrefix}-web`,
      generateSecret: false,
      authFlows: { userSrp: true, userPassword: params.enablePasswordAuthFlow },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.resourceServer(resourceServer, readScope),
          cognito.OAuthScope.resourceServer(resourceServer, writeScope),
        ],
        callbackUrls: params.callbackUrls,
        logoutUrls: params.logoutUrls,
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true, // sign-in errors do not reveal whether a user exists
      enableTokenRevocation: true,
      accessTokenValidity: cdk.Duration.minutes(60),
      idTokenValidity: cdk.Duration.minutes(60),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // Machine-to-machine client: client_credentials, read scope only. Machine tokens carry no user.
    const machineClient = userPool.addClient('MachineClient', {
      userPoolClientName: `${namePrefix}-machine`,
      generateSecret: true,
      authFlows: {},
      oAuth: {
        flows: { clientCredentials: true },
        scopes: [cognito.OAuthScope.resourceServer(resourceServer, readScope)],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: cdk.Duration.minutes(60),
    });

    // Hosted domain: hosts the /oauth2/token and /login endpoints. The prefix must be globally unique
    // and may not contain the words aws, amazon or cognito.
    const domain = userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `${project}-${environment}-auth-${cdk.Aws.ACCOUNT_ID}` },
    });

    // ---------------------------------------------------------------------------------------------
    // Data + Lambda
    // ---------------------------------------------------------------------------------------------
    const table = new dynamodb.Table(this, 'NotesTable', {
      tableName: `${namePrefix}-notes`,
      partitionKey: { name: 'sub', type: dynamodb.AttributeType.STRING }, // token subject = data owner
      sortKey: { name: 'noteId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    const makeFunction = (idPrefix: string, entryFile: string, name: string, env: Record<string, string> = {}) =>
      new lambdaNodejs.NodejsFunction(this, `${idPrefix}Function`, {
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(__dirname, '../../src/handlers', `${entryFile}.ts`),
        handler: 'handler',
        functionName: `${namePrefix}-${name}`,
        timeout: cdk.Duration.seconds(10),
        memorySize: 256,
        environment: env,
        logGroup: new logs.LogGroup(this, `${idPrefix}LogGroup`, { retention: logs.RetentionDays.ONE_WEEK, removalPolicy }),
      });

    const meFunction = makeFunction('Me', 'me', 'me');
    const adminFunction = makeFunction('Admin', 'admin', 'admin');
    const notesFunction = makeFunction('Notes', 'notes', 'notes', { TABLE_NAME: table.tableName });
    notesFunction.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:PutItem', 'dynamodb:Query'], resources: [table.tableArn] }));

    // ---------------------------------------------------------------------------------------------
    // API Gateway with the Cognito authorizer
    // ---------------------------------------------------------------------------------------------
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy });
    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: `${namePrefix}-api`,
      description: 'REST API protected by an Amazon Cognito user pool',
      cloudWatchRole: true,
      deployOptions: {
        stageName: environment,
        throttlingRateLimit: params.apiRateLimit,
        throttlingBurstLimit: params.apiBurstLimit,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
    });

    // Without scopes the authorizer expects an ID token; with `authorizationScopes` it expects an
    // ACCESS token (scopes only exist there). Mixing them up returns 401.
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'Authorizer', {
      cognitoUserPools: [userPool],
      authorizerName: `${namePrefix}-authorizer`,
      identitySource: 'method.request.header.Authorization',
    });

    const requestValidator = api.addRequestValidator('RequestValidator', {
      requestValidatorName: `${namePrefix}-request-validator`,
      validateRequestBody: true,
      validateRequestParameters: true,
    });
    const createNoteModel = api.addModel('CreateNoteModel', {
      modelName: 'CreateNote',
      contentType: 'application/json',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        type: apigateway.JsonSchemaType.OBJECT,
        required: ['text'],
        additionalProperties: false,
        properties: { text: { type: apigateway.JsonSchemaType.STRING, minLength: 1, maxLength: 500 } },
      },
    });

    const secured = (extra: Partial<apigateway.MethodOptions> = {}): apigateway.MethodOptions => ({
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer,
      requestValidator,
      ...extra,
    });

    api.root.addResource('me').addMethod('GET', new apigateway.LambdaIntegration(meFunction), secured());
    api.root.addResource('admin').addMethod('GET', new apigateway.LambdaIntegration(adminFunction), secured());

    const notes = api.root.addResource('notes');
    const notesIntegration = new apigateway.LambdaIntegration(notesFunction);
    notes.addMethod('GET', notesIntegration, secured({ authorizationScopes: ['notes/read'] }));
    notes.addMethod(
      'POST',
      notesIntegration,
      secured({ authorizationScopes: ['notes/write'], requestModels: { 'application/json': createNoteModel } }),
    );

    // ---------------------------------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url, description: 'API Gateway URL' });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'WebClientId', { value: webClient.userPoolClientId });
    new cdk.CfnOutput(this, 'MachineClientId', { value: machineClient.userPoolClientId });
    new cdk.CfnOutput(this, 'TokenEndpoint', {
      value: `https://${domain.domainName}.auth.${this.region}.amazoncognito.com/oauth2/token`,
      description: 'OAuth2 token endpoint (client_credentials / authorization code)',
    });
    new cdk.CfnOutput(this, 'NotesTableName', { value: table.tableName });
  }
}
