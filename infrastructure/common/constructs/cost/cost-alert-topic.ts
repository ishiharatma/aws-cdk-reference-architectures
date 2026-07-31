import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface CostAlertTopicProps {
    /** Name of the SNS topic */
    readonly topicName: string;
    /** Email addresses to subscribe to the topic */
    readonly emails: string[];
    /**
     * Grant `budgets.amazonaws.com` permission to publish to this topic.
     * Required for AWS Budgets notifications; without it, budget
     * notifications configured with an SNS subscriber silently fail.
     * @default false
     */
    readonly allowBudgetsPublish?: boolean;
    /**
     * Grant `costalerts.amazonaws.com` (Cost Anomaly Detection) permission
     * to publish to this topic.
     * @default false
     */
    readonly allowCostAnomalyDetectionPublish?: boolean;
    /**
     * Grant `cloudwatch.amazonaws.com` permission to publish to this topic.
     * Required for CloudWatch Alarm actions targeting SNS — unlike Budgets
     * and Cost Anomaly Detection, CDK's `cloudwatch-actions.SnsAction` does
     * NOT auto-grant this, so it must be requested explicitly.
     * @default false
     */
    readonly allowCloudWatchAlarmPublish?: boolean;
}

/**
 * A cost-alerting SNS topic pre-wired for the AWS cost/billing services that
 * need to publish to it directly as a service principal (not via IAM role
 * assumption). Deliberately does NOT use a customer-managed KMS key: AWS's
 * own troubleshooting docs for both Budgets and Cost Anomaly Detection list
 * topic encryption as a common cause of silently dropped notifications,
 * since the service principal would also need key-policy grants. In-transit
 * encryption is still enforced via `enforceSSL`.
 *
 * @see https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-sns-policy.html
 * @see https://docs.aws.amazon.com/cost-management/latest/userguide/ad-SNS.html
 */
export class CostAlertTopic extends Construct {
    public readonly topic: sns.Topic;

    constructor(scope: Construct, id: string, props: CostAlertTopicProps) {
        super(scope, id);

        this.topic = new sns.Topic(this, 'Topic', {
            topicName: props.topicName,
            enforceSSL: true,
        });

        for (const email of props.emails) {
            this.topic.addSubscription(new subscriptions.EmailSubscription(email));
        }

        if (props.allowBudgetsPublish) {
            this.topic.addToResourcePolicy(
                new iam.PolicyStatement({
                    sid: 'AllowBudgetsToPublish',
                    effect: iam.Effect.ALLOW,
                    principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
                    actions: ['sns:Publish'],
                    resources: [this.topic.topicArn],
                    conditions: {
                        StringEquals: { 'aws:SourceAccount': cdk.Stack.of(this).account },
                        ArnLike: {
                            'aws:SourceArn': `arn:${cdk.Stack.of(this).partition}:budgets::${cdk.Stack.of(this).account}:*`,
                        },
                    },
                }),
            );
        }

        if (props.allowCostAnomalyDetectionPublish) {
            this.topic.addToResourcePolicy(
                new iam.PolicyStatement({
                    sid: 'AllowCostAnomalyDetectionToPublish',
                    effect: iam.Effect.ALLOW,
                    principals: [new iam.ServicePrincipal('costalerts.amazonaws.com')],
                    actions: ['sns:Publish'],
                    resources: [this.topic.topicArn],
                    conditions: {
                        StringEquals: { 'aws:SourceAccount': cdk.Stack.of(this).account },
                    },
                }),
            );
        }

        if (props.allowCloudWatchAlarmPublish) {
            this.topic.grantPublish(new iam.ServicePrincipal('cloudwatch.amazonaws.com'));
        }
    }
}
