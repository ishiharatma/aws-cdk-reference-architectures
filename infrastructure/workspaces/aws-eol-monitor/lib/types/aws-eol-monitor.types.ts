import * as cdk from 'aws-cdk-lib';

/**
 * Notification targets for the EOL digest report.
 */
export interface NotificationParams {
  /** Email addresses subscribed to the SNS report topic. */
  readonly emails: string[];
}

/**
 * Data-collection settings: where the upstream dataset lives and how close to
 * its support-end date a version must be to count as "upcoming".
 */
export interface CollectorParams {
  /**
   * Raw URL of `awslabs/aws-service-eol-data`'s `data/eol.json`.
   * Pinning to a tag/commit instead of `main` avoids upstream schema
   * changes breaking the parser without notice.
   */
  readonly datasetUrl: string;
  /**
   * A version newly inside this many days of `standardSupportEnd` is
   * reported as "upcoming EOL", not just tracked silently.
   */
  readonly upcomingThresholdDays: number;
}

/**
 * Schedule for the periodic check (EventBridge Scheduler cron/rate expression).
 */
export interface ScheduleParams {
  readonly scheduleExpression: string;
  /** Time zone the cron expression is interpreted in. @default TimeZone.ASIA_TOKYO */
  readonly scheduleTimeZone?: cdk.TimeZone;
}

/**
 * Bedrock model settings for the natural-language digest.
 */
export interface ReportParams {
  /** Bedrock model ID or cross-region inference profile ID. */
  readonly bedrockModelId: string;
  /** Report language for the Bedrock-generated digest. */
  readonly locale: 'ja' | 'en';
}
