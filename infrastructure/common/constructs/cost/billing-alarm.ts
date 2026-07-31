import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Construct } from 'constructs';

export interface BillingAlarmProps {
    /** Prefix used to name the alarm */
    readonly alarmNamePrefix: string;
    /**
     * USD threshold above which the alarm goes into ALARM state, compared
     * against the AWS/Billing EstimatedCharges metric (the account's
     * cumulative estimated charge for the current billing period).
     */
    readonly thresholdUsd: number;
    /**
     * SNS topic to notify — must already permit `cloudwatch.amazonaws.com`
     * to publish (see `CostAlertTopic`'s `allowCloudWatchAlarmPublish`).
     */
    readonly topic: sns.ITopic;
}

/**
 * The classic CloudWatch "EstimatedCharges" billing alarm.
 *
 * Two account-level prerequisites this construct cannot configure:
 *  1. "Receive Billing Alerts" must be enabled once, manually, under
 *     Billing preferences — there is no CloudFormation/CDK resource for
 *     this account preference, and without it no EstimatedCharges data is
 *     published at all.
 *  2. The `AWS/Billing` metric is only ever published to **us-east-1**,
 *     regardless of which region you operate in day to day — the stack
 *     using this construct must be deployed to us-east-1.
 */
export class BillingAlarm extends Construct {
    public readonly alarm: cloudwatch.IAlarm;

    constructor(scope: Construct, id: string, props: BillingAlarmProps) {
        super(scope, id);

        const estimatedCharges = new cloudwatch.Metric({
            namespace: 'AWS/Billing',
            metricName: 'EstimatedCharges',
            dimensionsMap: { Currency: 'USD' },
            // Billing metrics are refreshed only a few times a day; a shorter
            // period just re-evaluates the same cached datapoint.
            period: cdk.Duration.hours(6),
            statistic: 'Maximum',
        });

        const alarm = new cloudwatch.Alarm(this, 'Resource', {
            alarmName: `${props.alarmNamePrefix}-estimated-charges`,
            alarmDescription: `Cumulative estimated AWS charges for the current billing period exceed $${props.thresholdUsd}`,
            metric: estimatedCharges,
            threshold: props.thresholdUsd,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        alarm.addAlarmAction(new cw_actions.SnsAction(props.topic));
        this.alarm = alarm;
    }
}
