import * as logs from 'aws-cdk-lib/aws-logs';
import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Production Environment Parameters
 *
 * Configuration optimized for:
 * - Longer log retention for audit purposes
 * - Stricter anomaly threshold (production traffic is more predictable)
 */
const prdParams: EnvParams = {
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',

    tags: {},

    sampleWaf: {
        logRetention: logs.RetentionDays.THREE_MONTHS,
    },

    cwLogsReport: {
        notificationEmail: process.env.NOTIFICATION_EMAIL_CWLOGS || 'change-me@example.com',
        anomalyThresholdPercent: 30,
        functionLogRetention: logs.RetentionDays.THREE_MONTHS,
    },

    athenaReport: {
        notificationEmail: process.env.NOTIFICATION_EMAIL_ATHENA || 'change-me@example.com',
        anomalyThresholdPercent: 30,
        functionLogRetention: logs.RetentionDays.THREE_MONTHS,
        queryResultsExpirationDays: 30,
    },
};

// Register in the params object
params[Environment.PRODUCTION] = prdParams;
