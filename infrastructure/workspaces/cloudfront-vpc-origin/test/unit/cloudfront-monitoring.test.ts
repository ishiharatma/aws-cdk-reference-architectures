import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { CloudfrontMonitoringStack } from 'lib/stacks/cloudfront-monitoring-stack';

const defaultEnv = {
  account: '123456789012',
  region: 'us-east-1',
};

function buildStack(alarmEmail?: string) {
  const app = new cdk.App();
  const stack = new CloudfrontMonitoringStack(app, 'CloudfrontMonitoringStack', {
    project: 'test-project',
    environment: Environment.TEST,
    env: defaultEnv,
    distributionId: 'E1EXAMPLE12345',
    alarmEmail,
  });
  return Template.fromStack(stack);
}

describe('CloudfrontMonitoringStack', () => {
  const template = buildStack('ops@example.com');

  test('alarms on the CloudFront 5xxErrorRate metric for the given distribution', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/CloudFront',
      MetricName: '5xxErrorRate',
      Dimensions: [{ Name: 'DistributionId', Value: 'E1EXAMPLE12345' }],
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 5,
    });
  });

  test('alarm notifies the SNS topic on both ALARM and OK', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const alarmProps = Object.values(alarms)[0].Properties;
    expect(alarmProps.AlarmActions).toHaveLength(1);
    expect(alarmProps.OKActions).toHaveLength(1);
  });

  test('SNS topic has an email subscription when alarmEmail is provided', () => {
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.com',
    });
  });

  test('outputs the alarm topic ARN', () => {
    template.hasOutput('AlarmTopicArn', {});
  });

  describe('when alarmEmail is not provided', () => {
    test('the SNS topic has no subscription', () => {
      const templateWithoutEmail = buildStack(undefined);
      templateWithoutEmail.resourceCountIs('AWS::SNS::Subscription', 0);
    });
  });
});
