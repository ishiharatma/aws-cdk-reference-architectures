import * as sns from 'aws-cdk-lib/aws-sns';
import * as ce from 'aws-cdk-lib/aws-ce';
import { Construct } from 'constructs';

export interface CostAnomalyDetectionProps {
    /** Prefix used to name the monitor and subscription */
    readonly namePrefix: string;
    /**
     * Dimension the anomaly monitor evaluates cost anomalies against.
     * @default 'SERVICE'
     */
    readonly monitorDimension?: 'SERVICE' | 'LINKED_ACCOUNT';
    /**
     * Minimum anomaly impact, as a percentage of expected spend, before a
     * notification is sent (ANOMALY_TOTAL_IMPACT_PERCENTAGE).
     */
    readonly thresholdPercentage: number;
    /**
     * Minimum anomaly impact, in absolute USD, before a notification is
     * sent (ANOMALY_TOTAL_IMPACT_ABSOLUTE). AND-combined with
     * thresholdPercentage, so both conditions must be met.
     */
    readonly thresholdAbsoluteUsd: number;
    /** SNS topic to notify — must already permit `costalerts.amazonaws.com` to publish (see `CostAlertTopic`) */
    readonly topic: sns.ITopic;
    /**
     * ARN of an existing `CfnAnomalyMonitor` to attach this subscription to,
     * instead of creating a new monitor.
     *
     * AWS allows only one AWS-managed SERVICE monitor per account (plus, at
     * most, one additional LINKED_ACCOUNT/TAG/COST_CATEGORY monitor, and only
     * in an AWS Organizations management account) — see
     * https://aws.amazon.com/blogs/aws-cloud-financial-management/extending-aws-managed-monitors-in-cost-anomaly-detection/.
     * If your account already has a SERVICE monitor (e.g. from another stack
     * using this construct), creating a second one fails with
     * `HandlerErrorCode: AlreadyExists`. Pass that monitor's ARN here to
     * attach an additional subscription to it instead.
     * @default undefined (a new monitor is created)
     */
    readonly existingMonitorArn?: string;
}

/**
 * An AWS Cost Anomaly Detection monitor + subscription, notifying via SNS
 * whenever an anomaly's impact exceeds BOTH a percentage-of-expected-spend
 * threshold AND an absolute-dollar threshold.
 *
 * IMPORTANT: SNS delivery requires `frequency: IMMEDIATE` — Cost Anomaly
 * Detection only supports SNS subscribers on IMMEDIATE subscriptions;
 * DAILY/WEEKLY frequencies are email-only. If you also want a periodic
 * digest by email, add a second `CfnAnomalySubscription` (DAILY/WEEKLY,
 * EMAIL subscribers) pointed at the same monitor ARN.
 */
export class CostAnomalyDetection extends Construct {
    /** The monitor this construct created, or `undefined` if `existingMonitorArn` was supplied instead. */
    public readonly monitor?: ce.CfnAnomalyMonitor;
    /** ARN of the monitor in use, whether newly created or passed in via `existingMonitorArn`. */
    public readonly monitorArn: string;
    public readonly subscription: ce.CfnAnomalySubscription;

    constructor(scope: Construct, id: string, props: CostAnomalyDetectionProps) {
        super(scope, id);

        if (props.existingMonitorArn) {
            this.monitorArn = props.existingMonitorArn;
        } else {
            this.monitor = new ce.CfnAnomalyMonitor(this, 'Monitor', {
                monitorName: `${props.namePrefix}-anomaly-monitor`,
                monitorType: 'DIMENSIONAL',
                monitorDimension: props.monitorDimension ?? 'SERVICE',
            });
            this.monitorArn = this.monitor.attrMonitorArn;
        }

        this.subscription = new ce.CfnAnomalySubscription(this, 'Subscription', {
            subscriptionName: `${props.namePrefix}-anomaly-subscription`,
            frequency: 'IMMEDIATE',
            monitorArnList: [this.monitorArn],
            subscribers: [{ type: 'SNS', address: props.topic.topicArn }],
            thresholdExpression: JSON.stringify({
                And: [
                    {
                        Dimensions: {
                            Key: 'ANOMALY_TOTAL_IMPACT_PERCENTAGE',
                            MatchOptions: ['GREATER_THAN_OR_EQUAL'],
                            Values: [String(props.thresholdPercentage)],
                        },
                    },
                    {
                        Dimensions: {
                            Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
                            MatchOptions: ['GREATER_THAN_OR_EQUAL'],
                            Values: [String(props.thresholdAbsoluteUsd)],
                        },
                    },
                ],
            }),
        });
    }
}
