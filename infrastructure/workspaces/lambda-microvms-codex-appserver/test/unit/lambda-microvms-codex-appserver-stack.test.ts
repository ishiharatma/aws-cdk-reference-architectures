import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { LambdaMicrovmsCodexAppserverStack } from 'lib/stacks/lambda-microvms-codex-appserver-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'test';
const envName: Environment = Environment.TEST;
const envParams = params[envName];
if (!envParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

describe('LambdaMicrovmsCodexAppserverStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new LambdaMicrovmsCodexAppserverStack(app, 'LambdaMicrovmsCodexAppserver', {
      project: projectName,
      environment: envName,
      isAutoDeleteObject: true,
      env: testEnv,
      params: envParams,
    });
    template = Template.fromStack(stack);
  });

  describe('Networking', () => {
    test('one VPC with a single NAT gateway for MicroVM egress', () => {
      template.resourceCountIs('AWS::EC2::VPC', 1);
      template.resourceCountIs('AWS::EC2::NatGateway', 1);
    });

    test('one network connector attaches MicroVms to the egress subnets', () => {
      template.resourceCountIs('AWS::Lambda::NetworkConnector', 1);
      template.hasResourceProperties('AWS::Lambda::NetworkConnector', {
        Configuration: Match.objectLike({
          VpcEgressConfiguration: Match.objectLike({
            AssociatedComputeResourceTypes: ['MicroVm'],
          }),
        }),
      });
    });
  });

  describe('MicroVM image', () => {
    test('exactly one codex app-server image, built for arm64', () => {
      template.resourceCountIs('AWS::Lambda::MicrovmImage', 1);
      template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
        CpuConfigurations: [Match.objectLike({ Architecture: 'ARM_64' })],
      });
    });

    test('image declares run/suspend/resume/terminate runtime hooks and a ready/validate build hook', () => {
      template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
        Hooks: Match.objectLike({
          MicrovmHooks: Match.objectLike({
            Run: Match.anyValue(),
            Suspend: Match.anyValue(),
            Resume: Match.anyValue(),
            Terminate: Match.anyValue(),
          }),
          MicrovmImageHooks: Match.objectLike({
            Ready: Match.anyValue(),
            Validate: Match.anyValue(),
          }),
        }),
      });
    });

    test('image carries the OpenAI API key secret ARN as an environment variable, never a raw value', () => {
      template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
        EnvironmentVariables: Match.arrayWith([Match.objectLike({ Key: 'OPENAI_API_KEY_SECRET_ARN' })]),
      });
    });
  });

  describe('Session store', () => {
    test('single on-demand sessions table with TTL, SSE, and point-in-time recovery', () => {
      template.resourceCountIs('AWS::DynamoDB::Table', 1);
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        BillingMode: 'PAY_PER_REQUEST',
        SSESpecification: { SSEEnabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      });
    });
  });

  describe('Control plane Lambdas', () => {
    test('five session lifecycle functions on the ARM64 Node.js 22 runtime', () => {
      template.resourceCountIs('AWS::Lambda::Function', 5);
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs22.x',
        Architectures: ['arm64'],
      });
    });

    test('functions carry the MicroVM image ARN and session table name', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            SESSIONS_TABLE_NAME: Match.anyValue(),
            MICROVM_IMAGE_ARN: Match.anyValue(),
          }),
        },
      });
    });

    test('functions are granted the lambda-microvms session lifecycle actions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: Match.arrayWith(['lambda-microvms:RunMicrovm', 'lambda-microvms:CreateMicrovmAuthToken']),
            }),
          ]),
        },
      });
    });
  });

  describe('Auth', () => {
    test('one Cognito user pool backs the HTTP API JWT authorizer', () => {
      template.resourceCountIs('AWS::Cognito::UserPool', 1);
      template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
      template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
        AuthorizerType: 'JWT',
      });
    });
  });

  describe('API Gateway', () => {
    test('one HTTP API with the five session routes', () => {
      template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
      template.resourceCountIs('AWS::ApiGatewayV2::Route', 5);
    });

    test('stage has access logging enabled', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
        AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue() }),
      });
    });
  });

  describe('Outputs', () => {
    test('exposes the API URL, MicroVM image ARN, and OpenAI secret ARN', () => {
      const outputs = template.findOutputs('*');
      expect(Object.keys(outputs)).toEqual(
        expect.arrayContaining(['ApiUrl', 'UserPoolId', 'UserPoolClientId', 'MicrovmImageArn', 'SessionsTableName', 'OpenAiApiKeySecretArn']),
      );
    });
  });
});
