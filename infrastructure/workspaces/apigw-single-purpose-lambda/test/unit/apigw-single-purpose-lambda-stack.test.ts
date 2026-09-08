/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { ApigwSinglePurposeLambdaStack } from 'lib/stacks/apigw-single-purpose-lambda-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'test';
const envName: Environment = Environment.TEST;
const envParams = params[envName];
if (!envParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

describe('ApigwSinglePurposeLambdaStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new ApigwSinglePurposeLambdaStack(app, 'ApigwSinglePurposeLambda', {
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
    test('one function per route (5 total), each on the ARM64 Node.js 22 runtime', () => {
      template.resourceCountIs('AWS::Lambda::Function', 5);
      template.allResourcesProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs22.x',
        Architectures: ['arm64'],
      });
    });

    test('each function has its own dedicated log group', () => {
      // 5 handler log groups + 1 API Gateway access-log group
      template.resourceCountIs('AWS::Logs::LogGroup', 6);
    });

    test('read routes get read-only access; write routes get write-only access', () => {
      const policies = Object.values(template.findResources('AWS::IAM::Policy'));
      const actionSets: string[][] = policies.map((p: any) =>
        (p.Properties.PolicyDocument.Statement as any[]).flatMap((s) =>
          Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [],
        ),
      );
      const hasReadOnly = actionSets.some((a) => a.includes('dynamodb:Scan') && !a.includes('dynamodb:PutItem'));
      const hasWriteOnly = actionSets.some(
        (a) => a.includes('dynamodb:PutItem') && !a.includes('dynamodb:GetItem') && !a.includes('dynamodb:Scan'),
      );
      expect(hasReadOnly).toBe(true);
      expect(hasWriteOnly).toBe(true);
    });
  });

  describe('API Gateway', () => {
    test('one REST API exposing /todos and /todos/{todoId}', () => {
      template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
      template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'todos' });
      template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: '{todoId}' });
    });

    test('exposes 5 explicit methods (GET/POST on the collection, GET/PUT/DELETE on the item)', () => {
      const methods = Object.values(template.findResources('AWS::ApiGateway::Method'));
      const verbs = methods.map((m: any) => m.Properties.HttpMethod).sort();
      expect(verbs).toEqual(['DELETE', 'GET', 'GET', 'POST', 'PUT']);
    });

    test('every method uses a Lambda AWS_PROXY integration', () => {
      template.allResourcesProperties('AWS::ApiGateway::Method', {
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
