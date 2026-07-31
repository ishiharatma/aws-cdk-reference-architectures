import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Environment } from '@common/parameters/environments';
import { CostAlertTopic, CostAnomalyDetection } from '@common/constructs/cost';
import { EnvParams } from 'parameters/environments';

export interface BudgetsCostAnomalyDetectionAnomalyStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
}

/**
 * Stack 2 – AWS Cost Anomaly Detection
 *
 * Creates a dimensional anomaly monitor (per AWS service) and an anomaly
 * subscription that publishes to SNS whenever the anomaly's impact exceeds
 * both a percentage AND an absolute-dollar threshold.
 *
 * IMPORTANT: SNS delivery for Cost Anomaly Detection requires
 * `frequency: IMMEDIATE`. `DAILY`/`WEEKLY` frequencies only support EMAIL
 * subscribers (see AWS::CE::AnomalySubscription docs). If you also want a
 * daily digest by email, add a second CfnAnomalySubscription with
 * frequency DAILY and EMAIL-only subscribers pointed at the same monitor.
 *
 * Architecture:
 *   CfnAnomalyMonitor (SERVICE) → CfnAnomalySubscription (IMMEDIATE) → SNS Topic
 *
 * AWS allows only one AWS-managed SERVICE monitor per account, so this
 * stack's monitor ARN is exposed (`monitorArn`) for Stack 3 (Unified) to
 * attach an additional subscription to, rather than creating a second,
 * conflicting SERVICE monitor of its own.
 */
export class BudgetsCostAnomalyDetectionAnomalyStack extends cdk.Stack {
    public readonly topic: sns.Topic;
    public readonly monitorArn: string;

    constructor(scope: Construct, id: string, props: BudgetsCostAnomalyDetectionAnomalyStackProps) {
        super(scope, id, props);

        const anomalyParams = props.params.anomalyDetection;
        const notificationParams = props.params.notification;

        const alertTopic = new CostAlertTopic(this, 'CostAnomalyTopic', {
            topicName: `${props.project}-${props.environment}-cost-anomaly-alerts`,
            emails: notificationParams.emails,
            allowCostAnomalyDetectionPublish: true,
        });
        this.topic = alertTopic.topic;

        const anomalyDetection = new CostAnomalyDetection(this, 'ServiceAnomalyDetection', {
            namePrefix: `${props.project}-${props.environment}-service`,
            monitorDimension: anomalyParams.monitorDimension,
            thresholdPercentage: anomalyParams.thresholdPercentage,
            thresholdAbsoluteUsd: anomalyParams.thresholdAbsoluteUsd,
            topic: this.topic,
        });
        this.monitorArn = anomalyDetection.monitorArn;
    }
}
