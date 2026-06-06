import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';

export const defaultLambdaArchiveConfig = {
    s3Prefix: 'subscriptions',
    retention: logs.RetentionDays.ONE_MONTH,
    filterPattern: '',
    memorySize: 256,
    timeout: cdk.Duration.minutes(1),
    logGroupNameSuffix: 'app-lambda',
};

/**
 * Parameters for Pattern C – Direct write (CloudWatch Logs → Lambda → S3)
 */
export interface LambdaArchiveParams {
    /**
     * S3 key prefix for archived log files
     * @default "subscriptions"
     */
    readonly s3Prefix?: string;
    /**
     * Log group name suffix: /{project}/{environment}/{suffix}
     */
    readonly logGroupNameSuffix?: string;
    /**
     * Retention period for the source log group
     * @default RetentionDays.ONE_MONTH
     */
    readonly retention?: logs.RetentionDays;
    /**
     * CloudWatch Logs subscription filter pattern
     * Use "" to match all events
     * @default "" (all events)
     */
    readonly filterPattern?: string;
    /**
     * Lambda function memory size (MB)
     * @default 256
     */
    readonly memorySize?: number;
    /**
     * Lambda function timeout
     * @default Duration.minutes(1)
     */
    readonly timeout?: cdk.Duration;
}
