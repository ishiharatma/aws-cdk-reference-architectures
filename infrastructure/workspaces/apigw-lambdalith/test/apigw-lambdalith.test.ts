import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ApigwLambdalithStack } from 'lib/stacks/apigw-lambdalith-stack';
import { Environment } from '@common/parameters/environments';

describe('ApigwLambdalithStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new ApigwLambdalithStack(app, 'TestStack', {
      project: 'test',
      environment: Environment.DEVELOPMENT,
      isAutoDeleteObject: true,
      params: {
        stackNamePrefix: 'apigw-lambdalith',
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

  test('snapshot matches', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});
