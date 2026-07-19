import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface CloudfrontMonitoringStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    /** ID of the CloudFront distribution to monitor (not the ARN — the 5xxErrorRate metric keys on DistributionId) */
    readonly distributionId: string;
    /**
     * Email address to notify when the 5xx error rate alarm changes state. If omitted, the SNS
     * topic is still created (its ARN is output) but has no subscription — subscribe to it
     * manually or from a downstream integration (e.g. ChatBot, PagerDuty).
     */
    readonly alarmEmail?: string;
}

/**
 * CloudFront's request/error metrics (namespace AWS/CloudFront) are only published to us-east-1,
 * regardless of the distribution's own region, and a CloudWatch Alarm can only evaluate a metric
 * in its own region. So this alarm (and the SNS topic it notifies) lives in its own stack, deployed
 * with env.region = 'us-east-1', separate from the main stack.
 *
 * Alarms on the distribution's overall 5xxErrorRate — the same signal AWS itself called out during
 * the 2026-07-16 CloudFront VPC Origins outage ("increased 5xx errors for CloudFront customers
 * utilizing VPC Origins connectivity") — so an operator finds out in time to consider flipping the
 * `publicAlbFailover` escape hatch (see the main stack / README Troubleshooting).
 */
export class CloudfrontMonitoringStack extends cdk.Stack {
  public readonly alarmTopic: sns.Topic;
  public readonly alarm: cloudwatch.Alarm;
  constructor(scope: Construct, id: string, props: CloudfrontMonitoringStackProps) {
    super(scope, id, props);

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${props.project}-${props.environment}-cloudfront-alarms`,
      displayName: `${props.project}-${props.environment} CloudFront alarms`,
      enforceSSL: true,
    });
    if (props.alarmEmail) {
      this.alarmTopic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));
    }

    const fiveXxErrorRate = new cloudwatch.Metric({
      namespace: 'AWS/CloudFront',
      metricName: '5xxErrorRate',
      dimensionsMap: { DistributionId: props.distributionId },
      period: cdk.Duration.minutes(5),
      statistic: cloudwatch.Stats.AVERAGE,
    });

    this.alarm = new cloudwatch.Alarm(this, 'CloudFront5xxErrorRateAlarm', {
      alarmName: `${props.project}-${props.environment}-cloudfront-5xx-error-rate`,
      alarmDescription: 'CloudFront 5xx error rate is elevated. Check whether VPC Origin connectivity ' +
        'is degraded (AWS Health Dashboard) and consider enabling the publicAlbFailover parameter as a ' +
        'temporary workaround — see the README Troubleshooting section.',
      metric: fiveXxErrorRate,
      // 5% sustained over 15 minutes distinguishes a real incident from occasional client errors
      // (4xx-adjacent noise, isolated retries) without paging on every blip.
      threshold: 5,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.alarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));
    this.alarm.addOkAction(new cloudwatch_actions.SnsAction(this.alarmTopic));

    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      description: 'SNS topic ARN notified when the CloudFront 5xx error rate alarm changes state',
    });
  }
}
