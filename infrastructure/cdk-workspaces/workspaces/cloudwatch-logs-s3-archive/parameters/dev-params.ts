import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 *
 * Configuration optimized for:
 * - Short buffering interval and size for quick feedback during development
 * - Short log retention to minimise storage costs
 * - Lifecycle thresholds that match the defaults (override here if needed)
 */
const devParams: EnvParams = {
    stackNamePrefix: 'cloudwatch-logs-s3-archive',

    // Firehose buffering: flush quickly in development for fast feedback
    firehose: {
        dataOutputPrefix: '!{timestamp:yyyy/MM/dd/HH}/',
        errorOutputPrefix: '!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/',
        timeZone: cdk.TimeZone.ASIA_TOKYO,
        bufferingInterval: cdk.Duration.seconds(60),
        bufferingSize: cdk.Size.mebibytes(1),
    },

    // Log group settings for Stack 1 (Basic) and Stack 2 (Lifecycle)
    logGroup: {
        logGroupNameSuffix: 'app',
        retention: logs.RetentionDays.ONE_WEEK,
        filterPattern: '',
    },

    // S3 lifecycle rules for Stack 2 – shortened for development inspection
    lifecycle: {
        moveToIaAfterDays: 30,
        moveToGlacierAfterDays: 90,
        moveToDeepArchiveAfterDays: 365,
        expireAfterDays: 2555,
        noncurrentVersionExpirationDays: 90,
        noncurrentVersionsToRetain: 3,
    },

    // Existing log group for Stack 3 (replace with an actual log group name)
    existingLogGroup: {
        logGroupName: '/aws/lambda/my-existing-function',
        filterPattern: '',
    },

    // Pattern B – Scheduled export task (Stack 4)
    exportTask: {
        scheduleExpression: 'rate(1 day)',
        s3Prefix: 'exports',
        logGroupNameSuffix: 'app-export',
        retention: logs.RetentionDays.ONE_WEEK,
        memorySize: 256,
        timeout: cdk.Duration.minutes(5),
    },

    // Pattern C – Lambda direct write (Stack 5)
    lambdaArchive: {
        s3Prefix: 'subscriptions',
        logGroupNameSuffix: 'app-lambda',
        retention: logs.RetentionDays.ONE_WEEK,
        filterPattern: '',
        memorySize: 256,
        timeout: cdk.Duration.minutes(1),
    },
};

params[Environment.DEVELOPMENT] = devParams;
