import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { CostAlertTopic, BillingAlarm } from '@common/constructs/cost';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

export interface BudgetsCostAnomalyDetectionBillingAlarmStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
}

/**
 * Stack 4 – Classic CloudWatch "EstimatedCharges" Billing Alarm
 *
 * The oldest AWS cost-alerting mechanism: a CloudWatch Alarm on the
 * account-level `AWS/Billing` `EstimatedCharges` metric, which reports the
 * account's cumulative estimated charge for the current billing period.
 *
 * IMPORTANT — two account-level prerequisites this stack cannot configure:
 *  1. "Receive Billing Alerts" must be enabled once, manually, under
 *     Billing preferences (Account Settings) for ANY EstimatedCharges data
 *     to be published at all. There is no CloudFormation/CDK resource for
 *     this account preference.
 *  2. The `AWS/Billing` metric is only ever published to **us-east-1**,
 *     regardless of which region you operate in day-to-day. This stack
 *     must be deployed to us-east-1 — see the region override applied in
 *     the Stage.
 *
 * Architecture:
 *   CloudWatch Alarm (AWS/Billing EstimatedCharges) → SNS Topic → Email
 */
export class BudgetsCostAnomalyDetectionBillingAlarmStack extends cdk.Stack {
    public readonly topic: sns.Topic;

    constructor(scope: Construct, id: string, props: BudgetsCostAnomalyDetectionBillingAlarmStackProps) {
        super(scope, id, props);

        const billingAlarmParams = props.params.billingAlarm;
        const notificationParams = props.params.notification;

        const alertTopic = new CostAlertTopic(this, 'BillingAlarmTopic', {
            topicName: `${props.project}-${props.environment}-billing-alarm`,
            emails: notificationParams.emails,
            allowCloudWatchAlarmPublish: true,
        });
        this.topic = alertTopic.topic;

        new BillingAlarm(this, 'EstimatedChargesAlarm', {
            alarmNamePrefix: `${props.project}-${props.environment}`,
            thresholdUsd: billingAlarmParams.thresholdUsd,
            topic: this.topic,
        });
    }
}
