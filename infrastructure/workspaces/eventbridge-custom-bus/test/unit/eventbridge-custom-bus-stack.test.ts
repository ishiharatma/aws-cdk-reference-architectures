/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { EventbridgeCustomBusStack } from 'lib/stacks/eventbridge-custom-bus-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envParams = params[Environment.TEST];
if (!envParams) {
  throw new Error('No parameters found for test environment');
}

const build = (overrides: Partial<typeof envParams> = {}) => {
  const app = new cdk.App();
  const stack = new EventbridgeCustomBusStack(app, 'EventbridgeCustomBus', {
    project: 'test',
    environment: Environment.TEST,
    isAutoDeleteObject: true,
    env: testEnv,
    params: { ...envParams, ...overrides },
  });
  return Template.fromStack(stack);
};

describe('EventbridgeCustomBusStack', () => {
  const template = build();
  const rule = (suffix: string): any =>
    (Object.values(template.findResources('AWS::Events::Rule')) as any[]).find((r) => r.Properties.Name.endsWith(suffix));

  describe('bus, archive and logging', () => {
    test('one custom bus with FULL INFO logging configured', () => {
      template.resourceCountIs('AWS::Events::EventBus', 1);
      template.hasResourceProperties('AWS::Events::EventBus', {
        Name: 'test-test-ebus-orders',
        LogConfig: { IncludeDetail: 'FULL', Level: 'INFO' },
      });
    });

    test('the bus log configuration is paired with a delivery to a log group (config alone writes nothing)', () => {
      template.hasResourceProperties('AWS::Logs::DeliverySource', { LogType: 'INFO_LOGS' });
      template.hasResourceProperties('AWS::Logs::DeliveryDestination', { OutputFormat: 'json' });
      template.resourceCountIs('AWS::Logs::Delivery', 1);
      template.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/aws/vendedlogs/events/event-bus/test-test-ebus-orders' });
    });

    test('everything from app.orders is archived for the configured retention', () => {
      template.hasResourceProperties('AWS::Events::Archive', {
        EventPattern: { source: ['app.orders'] },
        RetentionDays: envParams.archiveRetentionDays,
      });
    });
  });

  describe('rule patterns', () => {
    test('high-value: numeric filter on the configured threshold, only OrderPlaced', () => {
      expect(rule('-high-value').Properties.EventPattern).toEqual({
        source: ['app.orders'],
        'detail-type': ['OrderPlaced'],
        detail: { amount: [{ numeric: ['>=', envParams.highValueThreshold] }] },
      });
    });

    test('the threshold is a parameter', () => {
      const other = build({ highValueThreshold: 5000 });
      const r = (Object.values(other.findResources('AWS::Events::Rule')) as any[]).find((x) => x.Properties.Name.endsWith('-high-value'));
      expect(r.Properties.EventPattern.detail.amount).toEqual([{ numeric: ['>=', 5000] }]);
    });

    test('eu-orders: prefix filter on the region', () => {
      expect(rule('-eu-orders').Properties.EventPattern.detail).toEqual({ region: [{ prefix: 'eu-' }] });
    });

    test('payment-failed: anything-but excludes customer cancellations', () => {
      expect(rule('-payment-failed').Properties.EventPattern).toEqual({
        source: ['app.orders'],
        'detail-type': ['PaymentFailed'],
        detail: { reason: [{ 'anything-but': ['user_cancelled'] }] },
      });
    });

    test('audit: every event of the source, nothing else', () => {
      expect(rule('-audit').Properties.EventPattern).toEqual({ source: ['app.orders'] });
    });

    test('every rule is on the custom bus (none on the default bus) and filters on the source', () => {
      const rules = Object.values(template.findResources('AWS::Events::Rule')) as any[];
      expect(rules).toHaveLength(4);
      rules.forEach((r) => {
        expect(r.Properties.EventBusName).toBeDefined();
        expect(r.Properties.EventPattern.source).toEqual(['app.orders']);
      });
    });
  });

  describe('targets', () => {
    test('SQS and Lambda targets have bounded retries, bounded age and a DLQ', () => {
      const sqsAndLambda = (Object.values(template.findResources('AWS::Events::Rule')) as any[])
        .filter((r) => !r.Properties.Name.endsWith('-audit'))
        .flatMap((r) => r.Properties.Targets);
      expect(sqsAndLambda).toHaveLength(3);
      sqsAndLambda.forEach((t) => {
        expect(t.RetryPolicy).toEqual({ MaximumRetryAttempts: envParams.targetRetryAttempts, MaximumEventAgeInSeconds: envParams.targetMaxEventAgeMinutes * 60 });
        expect(t.DeadLetterConfig.Arn).toBeDefined();
      });
    });

    test('the high-value target reshapes the event with an input transformer', () => {
      const target = rule('-high-value').Properties.Targets[0];
      expect(target.InputTransformer.InputPathsMap).toEqual({
        'detail-orderId': '$.detail.orderId',
        'detail-amount': '$.detail.amount',
        'detail-region': '$.detail.region',
      });
    });

    test('the audit rule writes to a CloudWatch Logs group directly (no Lambda in the path)', () => {
      const target = rule('-audit').Properties.Targets[0];
      expect(JSON.stringify(target.Arn)).toContain('AuditLogGroup');
      expect(Object.keys(template.findResources('AWS::Lambda::Function')).length).toBeGreaterThanOrEqual(1);
    });

    test('queues are encrypted, TLS-only, and the DLQ retains messages for 14 days', () => {
      template.resourceCountIs('AWS::SQS::Queue', 3);
      template.allResourcesProperties('AWS::SQS::Queue', { SqsManagedSseEnabled: true });
      template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'test-test-ebus-target-dlq', MessageRetentionPeriod: 14 * 24 * 60 * 60 });
      template.resourceCountIs('AWS::SQS::QueuePolicy', 3);
    });

    test('only the processor function writes to DynamoDB, PutItem only', () => {
      const statements = (Object.values(template.findResources('AWS::IAM::Policy')) as any[]).flatMap((p) => p.Properties.PolicyDocument.Statement);
      const dynamo = statements.filter((s) => [].concat(s.Action).some((a: string) => a.startsWith('dynamodb:')));
      expect(dynamo).toHaveLength(1);
      expect(dynamo[0].Action).toEqual('dynamodb:PutItem');
    });
  });

  test('a DLQ alarm exists', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'ApproximateNumberOfMessagesVisible', Threshold: 1 });
  });

  test('outputs the values used by test-eventbus.sh', () => {
    const outputs = Object.keys(template.toJSON().Outputs);
    ['EventBusName', 'ArchiveName', 'HighValueQueueUrl', 'PaymentFailedQueueUrl', 'TargetDlqUrl', 'ProcessedTableName', 'AuditLogGroupName'].forEach((n) =>
      expect(outputs).toContain(n),
    );
  });
});
