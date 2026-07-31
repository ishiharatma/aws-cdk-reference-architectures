import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as chatbot from 'aws-cdk-lib/aws-chatbot';
import {
    CostAlertTopic,
    CostBudget,
    CostAnomalyDetection,
    SafeSlackChannelConfiguration,
} from '@common/constructs/cost';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

export interface BudgetsCostAnomalyDetectionUnifiedStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
    /**
     * ARN of Stack 2's Cost Anomaly Detection monitor. AWS allows only one
     * AWS-managed SERVICE monitor per account, so this stack attaches an
     * additional subscription to Stack 2's existing monitor instead of
     * creating a second, conflicting one.
     */
    readonly anomalyMonitorArn: string;
}

/**
 * Stack 3 – Unified FinOps alerting with optional Slack delivery
 *
 * Wires one Budget and one Cost Anomaly Detection subscription to a single
 * shared SNS topic, then (optionally) fans that topic out to a Slack
 * channel via AWS Chatbot. This is the "practical" shape most teams want:
 * one alert channel for every cost signal instead of managing separate
 * topics/subscriptions per signal type.
 *
 * Slack delivery is only created when params.notification.slack is set;
 * otherwise the topic still delivers via email exactly like Stacks 1/2.
 *
 * IMPORTANT: This stack depends on Stack 2 (Anomaly) for its monitor. AWS
 * Cost Anomaly Detection allows only one AWS-managed SERVICE monitor per
 * account — see
 * https://aws.amazon.com/blogs/aws-cloud-financial-management/extending-aws-managed-monitors-in-cost-anomaly-detection/ —
 * so creating a second SERVICE monitor here would fail with
 * `HandlerErrorCode: AlreadyExists` once Stack 2 exists. Instead, this stack
 * attaches its own `CfnAnomalySubscription` to Stack 2's monitor ARN.
 *
 * Architecture:
 *   CfnBudget ─┐
 *              ├─→ SNS Topic (FinOpsAlertTopic) ─→ Email
 *   CfnAnomalySubscription (attached to Stack 2's monitor) ─┘  └─→ AWS Chatbot → Slack (optional)
 */
export class BudgetsCostAnomalyDetectionUnifiedStack extends cdk.Stack {
    public readonly topic: sns.Topic;

    constructor(scope: Construct, id: string, props: BudgetsCostAnomalyDetectionUnifiedStackProps) {
        super(scope, id, props);

        const budgetParams = props.params.budget;
        const anomalyParams = props.params.anomalyDetection;
        const notificationParams = props.params.notification;

        const alertTopic = new CostAlertTopic(this, 'FinOpsAlertTopic', {
            topicName: `${props.project}-${props.environment}-finops-alerts`,
            emails: notificationParams.emails,
            allowBudgetsPublish: true,
            allowCostAnomalyDetectionPublish: true,
        });
        this.topic = alertTopic.topic;

        // -----------------------------------------------------------------------
        // Budget: single account-wide monthly cost budget
        // -----------------------------------------------------------------------
        new CostBudget(this, 'UnifiedMonthlyCostBudget', {
            budgetName: `${props.project}-${props.environment}-unified-monthly-cost`,
            amount: budgetParams.amount,
            unit: budgetParams.unit,
            notifications: budgetParams.notifications,
            topic: this.topic,
            emails: notificationParams.emails,
        });

        // -----------------------------------------------------------------------
        // Cost Anomaly Detection: an additional IMMEDIATE subscription on
        // Stack 2's existing monitor, feeding the shared topic (see Stack 2
        // for why frequency must be IMMEDIATE for SNS, and the class doc
        // above for why this reuses Stack 2's monitor instead of creating a
        // new one).
        //
        // Uses `anomalyParams.unifiedEscalation` (a stricter threshold) when
        // configured, so Stack 3 only pages the unified/Slack channel for
        // larger anomalies than Stack 2's own subscription — otherwise the
        // same monitor would report every qualifying anomaly twice with no
        // distinction between the two channels. Falls back to the same
        // thresholds as Stack 2 if `unifiedEscalation` isn't set.
        // -----------------------------------------------------------------------
        const anomalyThreshold = anomalyParams.unifiedEscalation ?? anomalyParams;
        new CostAnomalyDetection(this, 'UnifiedAnomalyDetection', {
            namePrefix: `${props.project}-${props.environment}-unified`,
            existingMonitorArn: props.anomalyMonitorArn,
            thresholdPercentage: anomalyThreshold.thresholdPercentage,
            thresholdAbsoluteUsd: anomalyThreshold.thresholdAbsoluteUsd,
            topic: this.topic,
        });

        // -----------------------------------------------------------------------
        // Optional: Slack delivery via AWS Chatbot
        // -----------------------------------------------------------------------
        if (notificationParams.slack) {
            new SafeSlackChannelConfiguration(this, 'SlackChannelConfiguration', {
                slackChannelConfigurationName: `${props.project}-${props.environment}-finops-alerts`,
                slackWorkspaceId: notificationParams.slack.workspaceId,
                slackChannelId: notificationParams.slack.channelId,
                notificationTopics: [this.topic],
                loggingLevel: chatbot.LoggingLevel.ERROR,
            });
        }
    }
}
