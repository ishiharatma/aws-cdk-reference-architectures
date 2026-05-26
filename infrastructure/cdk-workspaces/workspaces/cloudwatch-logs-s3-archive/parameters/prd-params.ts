import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Production Environment Parameters
 *
 * Configuration optimized for:
 * - Larger buffering size/interval to reduce S3 PUT costs
 * - Long log retention to satisfy audit requirements
 * - Full 7-year lifecycle chain for compliance archiving
 */
const prdParams: EnvParams = {
    stackNamePrefix: 'cloudwatch-logs-s3-archive',

    // Firehose buffering: larger window reduces small-object costs in production
    firehose: {
        dataOutputPrefix: '!{timestamp:yyyy/MM/dd/HH}/',
        errorOutputPrefix: '!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/',
        timeZone: cdk.TimeZone.ASIA_TOKYO,
        bufferingInterval: cdk.Duration.seconds(300),
        bufferingSize: cdk.Size.mebibytes(64),
    },

    // Log group settings for Stack 1 (Basic) and Stack 2 (Lifecycle)
    logGroup: {
        logGroupNameSuffix: 'app',
        retention: logs.RetentionDays.THREE_MONTHS,
        filterPattern: '',
    },

    // S3 lifecycle rules for Stack 2 – 7-year retention for compliance
    lifecycle: {
        moveToIaAfterDays: 30,
        moveToGlacierAfterDays: 90,
        moveToDeepArchiveAfterDays: 365,
        expireAfterDays: 2555,
        noncurrentVersionExpirationDays: 90,
        noncurrentVersionsToRetain: 3,
    },

    // Existing log group for Stack 3 (replace with the actual production log group)
    existingLogGroup: {
        logGroupName: '/aws/lambda/my-production-function',
        filterPattern: '',
    },
};

params[Environment.PRODUCTION] = prdParams;
