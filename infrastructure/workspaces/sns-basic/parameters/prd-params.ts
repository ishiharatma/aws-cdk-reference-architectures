import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { params, EnvParams } from 'parameters/environments';
import { Environment } from "@common/parameters/environments";

/**
 * Production Environment Parameters
 *
 * Configuration optimized for:
 * - Longer log retention for audit purposes
 * - Larger Firehose buffering to reduce S3 PUT costs
 */
const prdParams: EnvParams = {
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',

    tags: {},

    snsBasic: {
        notificationEmail: process.env.NOTIFICATION_EMAIL || 'change-me@example.com',
        functionLogRetention: logs.RetentionDays.ONE_MONTH,
        cwLogsRetention: logs.RetentionDays.ONE_MONTH,
        firehoseBufferingInterval: cdk.Duration.seconds(300),
        firehoseBufferingSize: cdk.Size.mebibytes(5),
    },

};

// Register in the params object
params[Environment.PRODUCTION] = prdParams;
