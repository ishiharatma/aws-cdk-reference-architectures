import * as cdk from 'aws-cdk-lib';

/**
 * Which part of the account the collectors look at.
 */
export interface TargetParams {
  /**
   * Regions to collect from. `us-east-1` is mandatory: AWS Config records
   * global resource types (IAM, CloudFront, Route 53, ...) there, so leaving it
   * out silently drops them from the diagram. Validated at synth time.
   */
  readonly regions: string[];
}

/**
 * When the pipeline runs and how the target month is decided.
 */
export interface ScheduleParams {
  /**
   * EventBridge Scheduler expression. Runs once a day inside a window at the
   * start of the month; the state machine itself decides whether to build the
   * report (CUR finalized, not built yet) or to exit and wait for tomorrow.
   */
  readonly scheduleExpression: string;
  /** Time zone the cron expression and the "previous month" calculation use. */
  readonly scheduleTimeZone: cdk.TimeZone;
  /**
   * Day of month from which the report is built even if CUR is not finalized
   * yet; the cost figures are then marked as provisional. Keep it inside the
   * schedule window or the report is never built.
   */
  readonly finalizeDeadlineDay: number;
}

/**
 * CUR 2.0 (Data Exports) location. Omit to run without cost data.
 */
export interface CurParams {
  /** Bucket the Data Exports export delivers to (same account). */
  readonly bucketName: string;
  /** S3 path prefix configured on the export (no leading/trailing slash). */
  readonly prefix: string;
  /** Export name. Files are read from `<prefix>/<exportName>/data/BILLING_PERIOD=YYYY-MM/`. */
  readonly exportName: string;
}

/**
 * Security collectors settings.
 */
export interface SecurityParams {
  /** Upper bound on findings read per source and region, to keep a run bounded. */
  readonly maxFindingsPerSource: number;
}

/**
 * Optional natural-language summary written by Bedrock.
 */
export interface SummaryParams {
  readonly enabled: boolean;
  /** Bedrock model ID or cross-region inference profile ID. */
  readonly bedrockModelId: string;
  readonly locale: 'ja' | 'en';
}

/**
 * How the report is published. Only `none` (S3 + webhook notification) is
 * implemented; `internal-alb` and `cloudfront` are the planned extensions.
 */
export interface DeliveryParams {
  readonly mode: 'none';
}

/**
 * Report retention in the data bucket.
 */
export interface RetentionParams {
  /** Days to keep `raw/` (collector output, more sensitive than the report). */
  readonly rawDays: number;
}
