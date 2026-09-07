import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ApigwLambdaWebAdapterStack } from 'lib/stacks/apigw-lambda-web-adapter-stack';
import { Environment } from '@common/parameters/environments';

describe('ApigwLambdaWebAdapterStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new ApigwLambdaWebAdapterStack(app, 'TestStack', {
      project: 'test',
      environment: Environment.DEVELOPMENT,
      isAutoDeleteObject: true,
      params: {
        stackNamePrefix: 'apigw-lambda-web-adapter',
        region: 'ap-northeast-1',
      },
    });
    template = Template.fromStack(stack);
  });

  test('creates a DynamoDB table with PAY_PER_REQUEST billing', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('creates an API Gateway REST API', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  });

  test('Lambda function has Lambda Web Adapter layer and env vars', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
          READINESS_CHECK_PATH: '/health',
          PORT: '8080',
        },
      },
    });
  });

  test('snapshot matches', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});
