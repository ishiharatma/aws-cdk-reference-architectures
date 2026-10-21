import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildStack } from '../helpers/stack';

describe('LambdaDurableFunctionsApprovalStack', () => {
  const stack = buildStack();
  const template = Template.fromStack(stack);
  const workflowLogicalId = stack.getLogicalId(
    stack.workflowFunction.node.defaultChild as cdk.CfnElement
  );

  describe('durable workflow function', () => {
    test('has DurableConfig from parameters (7 days / 14 days retention)', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-test-ldf-approval-workflow',
        DurableConfig: { ExecutionTimeout: 7 * 24 * 3600, RetentionPeriodInDays: 14 },
        Runtime: 'nodejs24.x',
        Timeout: 60,
      });
    });

    test('is the only durable function', () => {
      const durable = template.findResources('AWS::Lambda::Function', {
        Properties: { DurableConfig: Match.anyValue() },
      });
      expect(Object.keys(durable)).toEqual([workflowLogicalId]);
    });

    test('uses the AWS managed durable execution policy (checkpoint + state)', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        ManagedPolicyArns: Match.arrayWith([
          Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp('AWSLambdaBasicDurableExecutionRolePolicy')]),
            ]),
          }),
        ]),
      });
    });

    test('sends the original event of failed executions to an encrypted DLQ', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-test-ldf-approval-workflow',
        DeadLetterConfig: { TargetArn: Match.anyValue() },
      });
      template.hasResourceProperties('AWS::SQS::Queue', { SqsManagedSseEnabled: true });
    });

    test('retains published versions so in-flight executions can resume on them', () => {
      template.hasResource('AWS::Lambda::Version', {
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
      });
    });

    test('is exposed through the live alias', () => {
      template.hasResourceProperties('AWS::Lambda::Alias', {
        Name: 'live',
        FunctionName: { Ref: workflowLogicalId },
      });
    });
  });

  describe('starter and decision functions', () => {
    test('starter gets the qualified alias ARN, never the unqualified function ARN', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-test-ldf-start-request',
        Environment: {
          Variables: {
            WORKFLOW_FUNCTION_ARN: { Ref: Match.stringLikeRegexp('WorkflowLiveAlias') },
          },
        },
      });
    });

    test('decision function may send callbacks only to executions of the workflow function', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'lambda:SendDurableExecutionCallbackSuccess',
              Effect: 'Allow',
              Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [workflowLogicalId, 'Arn'] }, ':*']] },
            }),
          ]),
        },
      });
    });

    test('no durable execution management permissions are granted to API handlers', () => {
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(policies).not.toMatch(/StopDurableExecution|GetDurableExecutionHistory/);
    });
  });

  describe('API', () => {
    test('every method requires IAM authorization', () => {
      const methods = template.findResources('AWS::ApiGateway::Method');
      expect(Object.keys(methods)).toHaveLength(3);
      for (const method of Object.values(methods)) {
        expect(method.Properties.AuthorizationType).toBe('AWS_IAM');
      }
    });

    test('request bodies are validated by JSON schema models', () => {
      template.resourceCountIs('AWS::ApiGateway::Model', 2);
      template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
        ValidateRequestBody: true,
      });
    });

    test('stage is throttled and access-logged', () => {
      template.hasResourceProperties('AWS::ApiGateway::Stage', {
        StageName: 'test',
        AccessLogSetting: Match.objectLike({ DestinationArn: Match.anyValue() }),
        MethodSettings: Match.arrayWith([
          Match.objectLike({ ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 }),
        ]),
      });
    });
  });

  describe('operations', () => {
    test('EventBridge rule matches abnormal endings of this function only', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          source: ['aws.lambda'],
          'detail-type': ['Durable Execution Status Change'],
          detail: {
            status: ['FAILED', 'TIMED_OUT', 'STOPPED'],
            functionArn: [
              { prefix: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [workflowLogicalId, 'Arn'] }, ':']] } },
            ],
          },
        },
      });
    });

    test('DLQ depth alarm notifies the alert topic', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'ApproximateNumberOfMessagesVisible',
        Threshold: 1,
        AlarmActions: [{ Ref: Match.stringLikeRegexp('AlertTopic') }],
      });
    });

    test('topics are KMS-encrypted and the key rotates', () => {
      const topics = template.findResources('AWS::SNS::Topic');
      for (const topic of Object.values(topics)) {
        expect(topic.Properties.KmsMasterKeyId).toBeDefined();
      }
      template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    });
  });

  describe('validation', () => {
    test('rejects an execution timeout that does not outlast the approval wait', () => {
      const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
      expect(() =>
        buildStack(app, {
          workflow: {
            executionTimeoutDays: 1,
            retentionDays: 14,
            approvalTimeoutHours: 48,
            invocationTimeoutSeconds: 60,
          },
        })
      ).toThrow(/executionTimeoutDays must be longer/);
    });
  });
});
