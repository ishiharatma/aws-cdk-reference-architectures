import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

const testParams: EnvParams = {
    stackNamePrefix: 'cloudwatch-logs-s3-archive',

    firehose: {
        dataOutputPrefix: '!{timestamp:yyyy/MM/dd/HH}/',
        errorOutputPrefix: '!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/',
        timeZone: cdk.TimeZone.ASIA_TOKYO,
        bufferingInterval: cdk.Duration.seconds(60),
        bufferingSize: cdk.Size.mebibytes(1),
    },

    logGroup: {
        logGroupNameSuffix: 'app',
        retention: logs.RetentionDays.ONE_WEEK,
        filterPattern: '',
    },

    lifecycle: {
        moveToIaAfterDays: 30,
        moveToGlacierAfterDays: 90,
        moveToDeepArchiveAfterDays: 365,
        expireAfterDays: 2555,
        noncurrentVersionExpirationDays: 90,
        noncurrentVersionsToRetain: 3,
    },

    existingLogGroup: {
        logGroupName: '/aws/lambda/test-function',
        filterPattern: '',
    },

    exportTask: {
        scheduleExpression: 'rate(1 day)',
        s3Prefix: 'exports',
        logGroupNameSuffix: 'app-export',
        retention: logs.RetentionDays.ONE_WEEK,
        memorySize: 256,
        timeout: cdk.Duration.minutes(5),
    },

    lambdaArchive: {
        s3Prefix: 'subscriptions',
        logGroupNameSuffix: 'app-lambda',
        retention: logs.RetentionDays.ONE_WEEK,
        filterPattern: '',
        memorySize: 256,
        timeout: cdk.Duration.minutes(1),
    },
};

params[Environment.TEST] = testParams;
