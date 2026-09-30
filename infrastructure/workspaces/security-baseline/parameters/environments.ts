import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * GuardDuty protection plans to enable on the detector.
 *
 * Foundational threat detection (CloudTrail, VPC Flow Logs, DNS) is always on; these are the optional,
 * separately-billed protection plans. Runtime Monitoring is intentionally not offered: it needs an agent
 * rollout and is a separate decision.
 */
export interface GuardDutyFeatureParams {
  /** S3 Protection: monitors S3 data events (object-level API calls). */
  readonly s3Protection: boolean;
  /** Malware Protection for EC2 (EBS volume scans on findings). */
  readonly ebsMalwareProtection: boolean;
  /** RDS Protection: anomalous login activity on Aurora / RDS. */
  readonly rdsLoginEvents: boolean;
  /** Lambda Protection: network activity logs from Lambda functions. */
  readonly lambdaNetworkLogs: boolean;
}

/** Notification of Security Hub findings by email. */
export interface NotificationParams {
  /** Security Hub severity labels that trigger a notification (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `INFORMATIONAL`). */
  readonly severities: string[];
  /** Email addresses subscribed to the topic; each must confirm the subscription. Empty creates no subscribers. */
  readonly emails: string[];
}

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  /** Days before objects in the shared log archive bucket (CloudTrail + Config) expire. */
  readonly logArchiveExpirationDays: number;
  /** Retention in days of the CloudTrail CloudWatch Logs log group. Must be a valid CloudWatch Logs retention value. */
  readonly trailLogGroupRetentionDays: number;
  /** GuardDuty optional protection plans. */
  readonly guardDuty: GuardDutyFeatureParams;
  /** Extra Security Hub standard ARNs to subscribe to, in addition to AWS Foundational Security Best Practices. */
  readonly additionalSecurityHubStandardArns: string[];
  /**
   * Create a second, paid Access Analyzer that reports unused access (unused roles, keys, permissions).
   * The free external-access analyzer is always created.
   */
  readonly enableUnusedAccessAnalyzer: boolean;
  /** Days without use after which the unused-access analyzer reports a finding. */
  readonly unusedAccessAgeDays: number;
  /** Findings notification (EventBridge rule -> SNS topic -> email). */
  readonly notification: NotificationParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
