import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { ApigwLambdaWebAdapterStack } from 'lib/stacks/apigw-lambda-web-adapter-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'test';
const envName: Environment = Environment.TEST;
const envParams = params[envName];
if (!envParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

describe('ApigwLambdaWebAdapterStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new ApigwLambdaWebAdapterStack(app, 'ApigwLambdaWebAdapter', {
      project: projectName,
      environment: envName,
      isAutoDeleteObject: true,
      env: testEnv,
      params: envParams,
    });
    template = Template.fromStack(stack);
  });

  describe('DynamoDB', () => {
    test('single on-demand table with SSE and point-in-time recovery', () => {
      template.resourceCountIs('AWS::DynamoDB::Table', 1);
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        BillingMode: 'PAY_PER_REQUEST',
        SSESpecification: { SSEEnabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
    });
  });

  describe('Lambda', () => {
    test('exactly one function serves the whole API', () => {
      template.resourceCountIs('AWS::Lambda::Function', 1);
    });

    test('function runs on the ARM64 Node.js 22 runtime', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs22.x',
        Architectures: ['arm64'],
      });
    });

    test('function attaches the Lambda Web Adapter layer', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Layers: Match.arrayWith([Match.stringLikeRegexp('.*:layer:LambdaAdapterLayerArm64:.*')]),
      });
    });

    test('function carries the Web Adapter wiring environment variables', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
            READINESS_CHECK_PATH: '/health',
            PORT: '8080',
            TABLE_NAME: Match.anyValue(),
          }),
        },
      });
    });

    test('function has read/write access to the Todos table only', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: Match.arrayWith(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem']),
            }),
          ]),
        },
      });
    });
  });

  describe('API Gateway', () => {
    test('one REST API with a greedy proxy resource on the ANY method', () => {
      template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
      template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: '{proxy+}' });
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'ANY',
        Integration: Match.objectLike({ Type: 'AWS_PROXY' }),
      });
    });

    test('stage has access logging and INFO method logging enabled', () => {
      template.hasResourceProperties('AWS::ApiGateway::Stage', {
        AccessLogSetting: Match.objectLike({ DestinationArn: Match.anyValue() }),
        MethodSettings: Match.arrayWith([Match.objectLike({ LoggingLevel: 'INFO' })]),
      });
    });
  });

  describe('Outputs', () => {
    test('exposes the API URL and table name', () => {
      const outputs = template.findOutputs('*');
      expect(Object.keys(outputs)).toEqual(expect.arrayContaining(['ApiUrl', 'TodosTableName']));
    });
  });
});
