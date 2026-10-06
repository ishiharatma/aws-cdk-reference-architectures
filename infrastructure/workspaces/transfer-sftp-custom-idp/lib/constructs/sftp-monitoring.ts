import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { MonitoringParams } from 'parameters/environments';

export interface SftpMonitoringProps {
  readonly alarmPrefix: string;
  readonly params: MonitoringParams;
  readonly removalPolicy: cdk.RemovalPolicy;
  /** Transfer Family structured log group (AUTH_FAILURE events). */
  readonly transferLogGroup: logs.ILogGroup;
  /** Custom IdP Lambda log group (rejection reasons). */
  readonly idpLogGroup: logs.ILogGroup;
}

/**
 * SNS topic and alarms. Log based alarms live as long as the stack. Server metric alarms (BytesIn / BytesOut)
 * need the server ID: for a CloudFormation-managed server use addServerAlarms(); for an on-demand server the
 * controller Lambda creates and deletes them (see lambda/server_controller).
 */
export class SftpMonitoring extends Construct {
  public readonly topic: sns.ITopic;
  public readonly namespace: string;
  private readonly props: SftpMonitoringProps;

  constructor(scope: Construct, id: string, props: SftpMonitoringProps) {
    super(scope, id);
    this.props = props;
    const { params, alarmPrefix } = props;
    const period = cdk.Duration.minutes(params.periodMinutes);
    this.namespace = `Sftp/${alarmPrefix}`;

    // CloudWatch alarms can not publish to a topic encrypted with the AWS managed key (aws/sns),
    // so the topic uses a customer managed key that trusts CloudWatch.
    const key = new kms.Key(this, 'AlertKey', {
      enableKeyRotation: true,
      description: `${alarmPrefix} SFTP alert topic key`,
      removalPolicy: props.removalPolicy,
    });
    key.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:SourceAccount': cdk.Stack.of(this).account } },
    }));
    const topic = new sns.Topic(this, 'AlertTopic', {
      topicName: `${alarmPrefix}-alerts`,
      masterKey: key,
      enforceSSL: true,
    });
    this.topic = topic;
    // Also covers alarms that the controller Lambda creates at runtime.
    topic.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [topic.topicArn],
      conditions: {
        StringEquals: { 'aws:SourceAccount': cdk.Stack.of(this).account },
        ArnLike: { 'aws:SourceArn': `arn:${cdk.Stack.of(this).partition}:cloudwatch:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:alarm:${alarmPrefix}-*` },
      },
    }));
    for (const email of params.alertEmails ?? []) {
      topic.addSubscription(new subscriptions.EmailSubscription(email));
    }

    // ---- log based alarms ----------------------------------------------------------------------
    this.logAlarm('AuthFailure', props.transferLogGroup, '"AUTH_FAILURE"', 'AuthFailureCount',
      params.authFailureThreshold, period,
      'Authentication failures reported by Transfer Family (unknown user, key mismatch, rejected by the IdP)');
    this.logAlarm('IpDenied', props.idpLogGroup, '"ip_not_allowed"', 'IpDeniedCount',
      params.ipDeniedThreshold, period,
      'Logins rejected because the source IP is not on the user allow list (a valid user from an unexpected IP)');
    this.logAlarm('IdpError', props.idpLogGroup, '?"dynamodb_error" ?"unexpected_error"', 'IdpErrorCount',
      1, period,
      'The custom IdP failed closed because of an internal error: every login is being rejected until this is fixed');
  }

  /** Alarms on the AWS/Transfer metrics of a server whose ID is known at deploy time. */
  public addServerAlarms(serverId: string): void {
    const { params, alarmPrefix } = this.props;
    const period = cdk.Duration.minutes(params.periodMinutes);
    for (const [metricName, thresholdMb] of [
      ['BytesIn', params.bytesInThresholdMb],
      ['BytesOut', params.bytesOutThresholdMb],
    ] as const) {
      const alarm = new cloudwatch.Alarm(this, `${metricName}Alarm`, {
        alarmName: `${alarmPrefix}-${metricName}`,
        alarmDescription: `${metricName} of the SFTP server exceeded ${thresholdMb} MB in ${params.periodMinutes} minutes`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Transfer',
          metricName,
          dimensionsMap: { ServerId: serverId },
          statistic: 'Sum',
          period,
        }),
        threshold: thresholdMb * 1024 * 1024,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(new cwActions.SnsAction(this.topic));
    }
  }

  /** Alarm on errors of a Lambda (used for the controller: a failed scheduled start or stop must be noticed). */
  public addLambdaErrorAlarm(id: string, alarmName: string, metric: cloudwatch.IMetric, description: string): void {
    const alarm = new cloudwatch.Alarm(this, id, {
      alarmName: `${this.props.alarmPrefix}-${alarmName}`,
      alarmDescription: description,
      metric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new cwActions.SnsAction(this.topic));
  }

  private logAlarm(
    id: string, logGroup: logs.ILogGroup, pattern: string, metricName: string,
    threshold: number, period: cdk.Duration, description: string,
  ): void {
    const filter = new logs.MetricFilter(this, `${id}Filter`, {
      logGroup,
      filterPattern: logs.FilterPattern.literal(pattern),
      metricNamespace: this.namespace,
      metricName,
      metricValue: '1',
      defaultValue: 0,
    });
    const alarm = new cloudwatch.Alarm(this, `${id}Alarm`, {
      alarmName: `${this.props.alarmPrefix}-${id}`,
      alarmDescription: description,
      metric: filter.metric({ statistic: 'Sum', period }),
      threshold,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new cwActions.SnsAction(this.topic));
  }
}
