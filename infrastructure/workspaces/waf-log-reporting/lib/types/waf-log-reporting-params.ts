import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';

export const defaultSampleWafConfig = {
    logRetention: logs.RetentionDays.TWO_WEEKS,
};

/**
 * Parameters for the standalone sample WAFv2 Web ACL.
 *
 * The Web ACL is created for demonstration purposes only and is not
 * associated with any protected resource (ALB/API Gateway/CloudFront). It
 * mixes a COUNT-mode managed rule group (to demonstrate Count-mode
 * reporting) with a BLOCK-mode managed rule group and a rate-based rule (to
 * demonstrate Block-mode reporting), and logs to a CloudWatch Logs log
 * group consumed by both report stacks.
 */
export interface SampleWafParams {
    /**
     * Retention for the WAF CloudWatch Logs log group.
     * @default logs.RetentionDays.TWO_WEEKS
     */
    readonly logRetention?: logs.RetentionDays;

    /**
     * Rate-based rule request limit (requests per 5-minute window per
     * origin IP) used by the BLOCK-mode sample rule.
     * @default 2000
     */
    readonly rateLimitPerIp?: number;
}

export const defaultReportConfig = {
    scheduleExpression: 'cron(0 0 * * ? *)', // daily at 00:00 in scheduleTimeZone
    scheduleTimeZone: cdk.TimeZone.ASIA_TOKYO,
    reportPeriodHours: 24,
    topN: 5,
    anomalyThresholdPercent: 50,
    locale: 'ja' as const,
    notificationEmail: 'change-me@example.com',
    functionMemorySize: 256,
    // Both report Lambdas run several sequential Logs Insights / Athena
    // queries per invocation, each of which can itself take up to ~60s.
    functionTimeout: cdk.Duration.minutes(5),
    functionLogRetention: logs.RetentionDays.ONE_MONTH,
};

/**
 * Parameters shared by both report stacks (schedule, notification, report
 * content tuning).
 */
export interface ReportBaseParams {
    /**
     * Email address subscribed to the report SNS topic. Must be confirmed
     * manually after deployment.
     * @default 'change-me@example.com'
     */
    readonly notificationEmail?: string;

    /**
     * EventBridge Scheduler expression (rate or cron) that triggers the
     * daily report Lambda.
     * @default 'cron(0 0 * * ? *)' (00:00 in scheduleTimeZone)
     */
    readonly scheduleExpression?: string;

    /**
     * Time zone applied to `scheduleExpression` when it is a cron expression.
     * @default cdk.TimeZone.ASIA_TOKYO
     */
    readonly scheduleTimeZone?: cdk.TimeZone;

    /**
     * Number of Top-N entries to include per report section (rules, IPs,
     * countries, URIs).
     * @default 5
     */
    readonly topN?: number;

    /**
     * Percentage increase in total request/block volume, compared with the
     * previous period, above which the report flags an anomaly.
     * @default 50
     */
    readonly anomalyThresholdPercent?: number;

    /**
     * Report text language.
     * @default 'ja'
     */
    readonly locale?: 'en' | 'ja';

    /**
     * Report Lambda memory size (MB).
     * @default 256
     */
    readonly functionMemorySize?: number;

    /**
     * Report Lambda timeout. Athena queries can take longer than a simple
     * Logs Insights query, so this bounds the total time spent polling for
     * query completion.
     * @default Duration.minutes(3)
     */
    readonly functionTimeout?: cdk.Duration;

    /**
     * Report Lambda log group retention.
     * @default logs.RetentionDays.ONE_MONTH
     */
    readonly functionLogRetention?: logs.RetentionDays;
}

/**
 * Parameters for Pattern 1 – CloudWatch Logs Insights + Lambda + SNS.
 */
export interface CwLogsReportParams extends ReportBaseParams {
    /**
     * Name of an existing WAF CloudWatch Logs log group to report on,
     * instead of the standalone sample Web ACL's log group. Set this to
     * point the report at a WAF that already exists in your account (the
     * log group name must still follow the `aws-waf-logs-*` naming
     * requirement enforced by AWS WAF).
     *
     * When unset, the report targets the sample Web ACL created by
     * `WafLogReportingSampleWafStack`.
     */
    readonly existingLogGroupName?: string;

    /**
     * Number of hours of log data to analyze per run.
     * @default 24
     */
    readonly reportPeriodHours?: number;
}

export const defaultAthenaReportConfig = {
    firehoseBufferingInterval: cdk.Duration.seconds(60),
    firehoseBufferingSize: cdk.Size.mebibytes(5),
    queryResultsExpirationDays: 7,
};

/**
 * Identifies an existing WAF's logs already delivered to Amazon S3, either
 * via AWS WAF's native S3 logging destination or via a Kinesis Data
 * Firehose delivery stream you manage yourself.
 */
export interface ExistingAthenaSourceParams {
    /** Name of the S3 bucket that already contains the WAF logs. */
    readonly bucketName: string;

    /**
     * S3 key prefix under which the logs live.
     *
     * - For AWS WAF's native S3 logging destination, this is the fixed
     *   path AWS WAF writes to: `AWSLogs/<account-id>/WAFLogs/<region>/<web-acl-name>/`.
     *   Pass `webAclName` (and optionally `accountId`/`region`) instead of
     *   this field and it is derived automatically.
     * - For a self-managed Firehose delivery, pass the Hive-style prefix
     *   you configured (e.g. `waf-logs/`), and set `hiveStylePartitioning: true`.
     */
    readonly keyPrefix?: string;

    /** Web ACL name, used to derive the native AWS WAF S3 log key prefix. */
    readonly webAclName?: string;

    /** AWS account ID that owns the logs. @default the stack's account */
    readonly accountId?: string;

    /** AWS region the Web ACL logs were generated in. @default the stack's region */
    readonly region?: string;

    /**
     * Whether the existing S3 layout already uses Hive-style
     * `key=value` partitioning (as produced by the Firehose sample path in
     * this reference architecture). When `false` (the default), the native
     * AWS WAF `.../yyyy/MM/dd/HH/...` layout is assumed and a single `day`
     * partition projection column is used instead.
     * @default false
     */
    readonly hiveStylePartitioning?: boolean;
}

/**
 * Parameters for Pattern 2 – Amazon Athena + Lambda + SNS.
 */
export interface AthenaReportParams extends ReportBaseParams {
    /**
     * Points the Athena table at logs already sitting in S3 (either AWS
     * WAF's native S3 destination or a self-managed Firehose/S3 pipeline)
     * instead of provisioning the sample Web ACL's own
     * CloudWatch Logs -> Firehose -> S3 pipeline.
     *
     * When unset, this stack subscribes a Firehose delivery stream to the
     * sample Web ACL's log group and builds the Glue table over its own
     * S3 bucket.
     */
    readonly existingSource?: ExistingAthenaSourceParams;

    /** Firehose buffering interval (sample-source mode only). @default Duration.seconds(60) */
    readonly firehoseBufferingInterval?: cdk.Duration;

    /** Firehose buffering size (sample-source mode only). @default Size.mebibytes(5) */
    readonly firehoseBufferingSize?: cdk.Size;

    /**
     * Number of days after which Athena query result objects are expired
     * from the query-results S3 bucket.
     * @default 7
     */
    readonly queryResultsExpirationDays?: number;
}

/**
 * Top-level parameters for the waf-log-reporting reference architecture.
 */
export interface WafLogReportingParams {
    readonly sampleWaf?: SampleWafParams;
    readonly cwLogsReport?: CwLogsReportParams;
    readonly athenaReport?: AthenaReportParams;
}
