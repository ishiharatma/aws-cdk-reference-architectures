/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { CognitoApigwAuthStack } from 'lib/stacks/cognito-apigw-auth-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envParams = params[Environment.TEST];
if (!envParams) {
  throw new Error('No parameters found for test environment');
}

const build = (overrides: Partial<typeof envParams> = {}) => {
  const app = new cdk.App();
  const stack = new CognitoApigwAuthStack(app, 'CognitoApigwAuth', {
    project: 'test',
    environment: Environment.TEST,
    isAutoDeleteObject: true,
    env: testEnv,
    params: { ...envParams, ...overrides },
  });
  return Template.fromStack(stack);
};

describe('CognitoApigwAuthStack', () => {
  const template = build();

  describe('user pool', () => {
    test('admin-created users, email sign-in, 12+ char password policy, optional TOTP-only MFA', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
        UsernameAttributes: ['email'],
        Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 12, RequireSymbols: true, RequireNumbers: true }) },
        MfaConfiguration: 'OPTIONAL',
        EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
        AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
      });
    });

    test('admin and member groups exist', () => {
      template.resourceCountIs('AWS::Cognito::UserPoolGroup', 2);
      template.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'admin' });
      template.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'member' });
    });

    test('resource server defines the notes/read and notes/write scopes', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', {
        Identifier: 'notes',
        Scopes: [
          { ScopeName: 'read', ScopeDescription: 'Read notes' },
          { ScopeName: 'write', ScopeDescription: 'Create notes' },
        ],
      });
    });
  });

  describe('app clients', () => {
    test('web client is public, uses code grant and does not reveal whether users exist', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        ClientName: 'test-test-authdemo-web',
        GenerateSecret: false,
        AllowedOAuthFlows: ['code'],
        PreventUserExistenceErrors: 'ENABLED',
        EnableTokenRevocation: true,
        ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      });
    });

    test('the password (non-SRP) flow follows the environment parameter', () => {
      const flows = (t: Template) =>
        (Object.values(t.findResources('AWS::Cognito::UserPoolClient')) as any[]).find((c) => c.Properties.ClientName.endsWith('-web')).Properties
          .ExplicitAuthFlows;
      expect(flows(build({ enablePasswordAuthFlow: false }))).not.toContain('ALLOW_USER_PASSWORD_AUTH');
    });

    test('machine client uses client_credentials with the read scope only', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        ClientName: 'test-test-authdemo-machine',
        GenerateSecret: true,
        AllowedOAuthFlows: ['client_credentials'],
        AllowedOAuthScopes: [Match.anyValue()], // <resource server id>/read, resolved at deploy time
      });
    });

    test('hosted domain prefix avoids the reserved words', () => {
      const domain = Object.values(template.findResources('AWS::Cognito::UserPoolDomain'))[0] as any;
      // Only the literal prefix matters (the account ID is appended as a token).
      expect(domain.Properties.Domain['Fn::Join'][1][0]).not.toMatch(/aws|amazon|cognito/i);
    });
  });

  describe('API authorization', () => {
    const methods = () =>
      (Object.values(template.findResources('AWS::ApiGateway::Method')) as any[]).filter((m) => m.Properties.HttpMethod !== 'OPTIONS');

    test('every method uses the Cognito authorizer', () => {
      expect(methods()).toHaveLength(4);
      methods().forEach((m) => {
        expect(m.Properties.AuthorizationType).toBe('COGNITO_USER_POOLS');
        expect(m.Properties.AuthorizerId).toBeDefined();
        expect(m.Properties.RequestValidatorId).toBeDefined();
      });
    });

    test('notes methods require scopes; me and admin require none (ID token)', () => {
      const notesGet = methods().filter((m) => m.Properties.AuthorizationScopes?.includes('notes/read'));
      const notesPost = methods().filter((m) => m.Properties.AuthorizationScopes?.includes('notes/write'));
      expect(notesGet).toHaveLength(1);
      expect(notesGet[0].Properties.HttpMethod).toBe('GET');
      expect(notesPost).toHaveLength(1);
      expect(notesPost[0].Properties.HttpMethod).toBe('POST');
      expect(methods().filter((m) => !m.Properties.AuthorizationScopes)).toHaveLength(2);
    });

    test('authorizer reads the Authorization header', () => {
      template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
        Type: 'COGNITO_USER_POOLS',
        IdentitySource: 'method.request.header.Authorization',
      });
    });

    test('POST body is validated against a JSON schema', () => {
      template.hasResourceProperties('AWS::ApiGateway::Model', { Schema: Match.objectLike({ required: ['text'], additionalProperties: false }) });
    });

    test('stage is throttled', () => {
      template.hasResourceProperties('AWS::ApiGateway::Stage', {
        MethodSettings: Match.arrayWith([Match.objectLike({ ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 })]),
      });
    });
  });

  describe('data and IAM', () => {
    test('notes are partitioned by the token subject', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        KeySchema: [
          { AttributeName: 'sub', KeyType: 'HASH' },
          { AttributeName: 'noteId', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
        SSESpecification: { SSEEnabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
    });

    test('only the notes function can reach DynamoDB, with Put/Query only', () => {
      const statements = (Object.values(template.findResources('AWS::IAM::Policy')) as any[]).flatMap((p) => p.Properties.PolicyDocument.Statement);
      const dynamo = statements.filter((s) => [].concat(s.Action).some((a: string) => a.startsWith('dynamodb:')));
      expect(dynamo).toHaveLength(1);
      expect(dynamo[0].Action.sort()).toEqual(['dynamodb:PutItem', 'dynamodb:Query']);
    });

    test('three ARM64 Node.js 24 functions with their own log groups', () => {
      template.resourceCountIs('AWS::Lambda::Function', 3);
      template.allResourcesProperties('AWS::Lambda::Function', { Runtime: 'nodejs24.x', Architectures: ['arm64'] });
      template.resourceCountIs('AWS::Logs::LogGroup', 4);
    });
  });

  test('outputs the values used by test-auth.sh', () => {
    const outputs = Object.keys(template.toJSON().Outputs);
    ['ApiUrl', 'UserPoolId', 'WebClientId', 'MachineClientId', 'TokenEndpoint', 'NotesTableName'].forEach((n) => expect(outputs).toContain(n));
  });
});
