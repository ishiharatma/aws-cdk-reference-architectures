import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

const testParams: EnvParams = {
    stackNamePrefix: 'budgets-cost-anomaly-detection',

    budget: {
        amount: 10,
        unit: 'USD',
        serviceFilter: ['Amazon Elastic Compute Cloud - Compute'],
        notifications: [
            { type: 'FORECASTED', thresholdPercent: 100 },
            { type: 'ACTUAL', thresholdPercent: 80 },
            { type: 'ACTUAL', thresholdPercent: 100 },
        ],
    },

    anomalyDetection: {
        monitorDimension: 'SERVICE',
        thresholdPercentage: 20,
        thresholdAbsoluteUsd: 5,
        unifiedEscalation: {
            thresholdPercentage: 50,
            thresholdAbsoluteUsd: 20,
        },
    },

    notification: {
        emails: ['test@example.com'],
    },

    billingAlarm: {
        thresholdUsd: 10,
    },

    costDigest: {
        scheduleExpression: 'cron(0 10 * * ? *)',
        periodDays: 7,
        angryThresholdUsd: 10,
    },
};

params[Environment.TEST] = testParams;
