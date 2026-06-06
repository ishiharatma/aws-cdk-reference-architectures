import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';

export const defaultExportTaskConfig = {
    scheduleExpression: 'rate(1 day)',
    s3Prefix: 'exports',
    retention: logs.RetentionDays.ONE_MONTH,
    memorySize: 256,
    timeout: cdk.Duration.minutes(5),
    logGroupNameSuffix: 'app-export',
};

/**
 * Parameters for Pattern B – Scheduled export task (CloudWatch Logs → S3 via CreateExportTask)
 */
export interface ExportTaskParams {
    /**
     * EventBridge schedule expression (rate or cron)
     * @example "rate(1 day)"
     * @example "cron(0 1 * * ? *)"  (daily at 01:00 UTC)
     * @default "rate(1 day)"
     */
    readonly scheduleExpression?: string;
    /**
     * S3 key prefix for exported log files
     * @default "exports"
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
     * Lambda function memory size (MB)
     * @default 256
     */
    readonly memorySize?: number;
    /**
     * Lambda function timeout
     * @default Duration.minutes(5)
     */
    readonly timeout?: cdk.Duration;
}
