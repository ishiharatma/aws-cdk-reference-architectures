import * as cdk from 'aws-cdk-lib';
import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 *
 * Configuration optimized for:
 * - Low budget/anomaly thresholds so notifications are easy to trigger and
 *   verify manually during development
 * - Placeholder email addresses that must be replaced with real addresses
 *   before deployment (SNS email subscriptions require confirmation anyway)
 */
const devParams: EnvParams = {
    stackNamePrefix: 'budgets-cost-anomaly-detection',

    // Stack 1: Budget alerts
    budget: {
        amount: 10,
        unit: 'USD',
        // Replace with a service name valid in your account, e.g. via:
        // aws ce get-dimension-values --dimension SERVICE --time-period Start=2026-01-01,End=2026-01-31
        serviceFilter: ['Amazon Elastic Compute Cloud - Compute'],
        // Notification rules are a plain array, so add/remove thresholds freely.
        notifications: [
            { type: 'FORECASTED', thresholdPercent: 100 },
            { type: 'ACTUAL', thresholdPercent: 80 },
            { type: 'ACTUAL', thresholdPercent: 100 },
            { type: 'ACTUAL', thresholdPercent: 200 }, // runaway-cost escalation
        ],
    },

    // Stack 2 / 3: Cost Anomaly Detection thresholds.
    // NOTE: AWS allows only one AWS-managed SERVICE monitor per account, so
    // Stack 3 attaches an additional subscription to Stack 2's monitor
    // rather than creating its own (see the Unified stack's class doc). In a
    // real deployment you would normally run Stack 2 *or* Stack 3 for
    // anomaly detection, not both — deploying both means every qualifying
    // anomaly is reported twice. `unifiedEscalation` below sets a stricter
    // threshold for Stack 3 purely to demonstrate that one monitor can feed
    // subscriptions with different severities; it doesn't make running both
    // stacks together non-redundant, it just changes what counts as
    // "unified-worthy".
    anomalyDetection: {
        monitorDimension: 'SERVICE',
        thresholdPercentage: 20,
        thresholdAbsoluteUsd: 5,
        // Escalation tier for Stack 3: only notably larger anomalies also
        // reach the unified/Slack channel.
        unifiedEscalation: {
            thresholdPercentage: 50,
            thresholdAbsoluteUsd: 20,
        },
    },

    // Shared notification targets
    notification: {
        emails: ['dev-team@example.com'],
        // Uncomment and set to enable Slack notifications via AWS Chatbot in Stacks 3/5
        // slack: {
        //     workspaceId: 'T0XXXXXXX',
        //     channelId: 'C0XXXXXXX',
        // },
        // Uncomment and set to enable Microsoft Teams notifications via AWS Chatbot in Stack 5
        // teams: {
        //     teamId: '00000000-0000-0000-0000-000000000000',
        //     tenantId: '00000000-0000-0000-0000-000000000000',
        //     channelId: '19%3aXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX%40thread.tacv2',
        // },
    },

    // Stack 4: classic CloudWatch EstimatedCharges billing alarm
    billingAlarm: {
        thresholdUsd: 10,
    },

    // Stack 5: scheduled cost digest to Slack/Teams
    costDigest: {
        scheduleExpression: 'cron(0 10 * * ? *)', // daily at 10:00 JST
        scheduleTimeZone: cdk.TimeZone.ASIA_TOKYO,
        periodDays: 7,
        angryThresholdUsd: 10,
        locale: 'en', // switch to 'ja' for a Japanese-language digest message
    },
};

params[Environment.DEVELOPMENT] = devParams;
