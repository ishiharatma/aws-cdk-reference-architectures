import * as cdk from 'aws-cdk-lib';
import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Production Environment Parameters
 *
 * Configuration optimized for:
 * - Realistic monthly budget and anomaly thresholds sized for actual spend
 * - Notification distribution list instead of individual addresses
 */
const prdParams: EnvParams = {
    stackNamePrefix: 'budgets-cost-anomaly-detection',

    // Stack 1: Budget alerts
    budget: {
        amount: 1000,
        unit: 'USD',
        // Replace with the production account's actual top-spend service(s)
        serviceFilter: ['Amazon Elastic Compute Cloud - Compute'],
    },

    // Stack 2 / 3: Cost Anomaly Detection thresholds.
    // NOTE: in production, run Stack 2 *or* Stack 3 for anomaly detection,
    // not both (see dev-params.ts for the full explanation of why).
    anomalyDetection: {
        monitorDimension: 'SERVICE',
        thresholdPercentage: 10,
        thresholdAbsoluteUsd: 100,
        // Escalation tier for Stack 3: only notably larger anomalies also
        // reach the unified/Slack channel.
        unifiedEscalation: {
            thresholdPercentage: 25,
            thresholdAbsoluteUsd: 500,
        },
    },

    // Shared notification targets
    notification: {
        emails: ['finops-alerts@example.com'],
        // slack: {
        //     workspaceId: 'T0XXXXXXX',
        //     channelId: 'C0XXXXXXX',
        // },
        // teams: {
        //     teamId: '00000000-0000-0000-0000-000000000000',
        //     tenantId: '00000000-0000-0000-0000-000000000000',
        //     channelId: '19%3aXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX%40thread.tacv2',
        // },
    },

    // Stack 4: classic CloudWatch EstimatedCharges billing alarm
    billingAlarm: {
        thresholdUsd: 1000,
    },

    // Stack 5: scheduled cost digest to Slack/Teams
    costDigest: {
        scheduleExpression: 'cron(0 10 * * ? *)', // daily at 10:00 JST
        scheduleTimeZone: cdk.TimeZone.ASIA_TOKYO,
        periodDays: 7,
        angryThresholdUsd: 150,
        locale: 'en', // switch to 'ja' for a Japanese-language digest message
    },
};

params[Environment.PRODUCTION] = prdParams;
