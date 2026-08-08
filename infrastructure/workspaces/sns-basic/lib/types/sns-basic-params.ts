import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';

export const defaultSnsBasicConfig = {
    notificationEmail: 'change-me@example.com',
    functionMemorySize: 128,
    functionTimeout: cdk.Duration.seconds(10),
    functionLogRetention: logs.RetentionDays.ONE_WEEK,
    apiHandlerMemorySize: 256,
    apiHandlerTimeout: cdk.Duration.seconds(10),
    cwLogsFilterPattern: '',
    cwLogsRetention: logs.RetentionDays.ONE_WEEK,
    firehoseBufferingInterval: cdk.Duration.seconds(60),
    firehoseBufferingSize: cdk.Size.mebibytes(1),
};

/**
 * Parameters for the sns-basic reference architecture.
 */
export interface SnsBasicParams {
    /**
     * Email address subscribed directly to the main SNS topic.
     * Must be confirmed manually (click the link in the confirmation email)
     * after deployment.
     * @default 'change-me@example.com'
     */
    readonly notificationEmail?: string;

    /**
     * Memory size (MB) for the simple "log the event" Lambda functions
     * (sqs-message-logger / sns-message-logger / cwlogs-to-sns / log-alert-notifier).
     * @default 128
     */
    readonly functionMemorySize?: number;

    /**
     * Timeout for the simple "log the event" Lambda functions.
     * @default 10 seconds
     */
    readonly functionTimeout?: cdk.Duration;

    /**
     * Log retention for all Lambda function log groups.
     * @default logs.RetentionDays.ONE_WEEK
     */
    readonly functionLogRetention?: logs.RetentionDays;

    /**
     * Memory size (MB) for the API Gateway backend Lambda (sns-http-endpoint)
     * that writes to S3 and DynamoDB.
     * @default 256
     */
    readonly apiHandlerMemorySize?: number;

    /**
     * Timeout for the API Gateway backend Lambda.
     * @default 10 seconds
     */
    readonly apiHandlerTimeout?: cdk.Duration;

    /**
     * CloudWatch Logs subscription filter pattern applied to the demo
     * application log group. Empty string matches all events.
     * @default ''
     */
    readonly cwLogsFilterPattern?: string;

    /**
     * Retention for the demo application log group.
     * @default logs.RetentionDays.ONE_WEEK
     */
    readonly cwLogsRetention?: logs.RetentionDays;

    /**
     * Firehose buffering interval before flushing to S3.
     * @default 60 seconds
     */
    readonly firehoseBufferingInterval?: cdk.Duration;

    /**
     * Firehose buffering size before flushing to S3.
     * @default 1 MiB
     */
    readonly firehoseBufferingSize?: cdk.Size;
}
