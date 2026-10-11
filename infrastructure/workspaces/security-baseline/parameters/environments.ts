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

/** Automatic remediation of Security Hub findings. */
export interface RemediationParams {
  /** `dry-run` records what would be done and changes nothing; `enforce` applies the change. Start with `dry-run`. */
  readonly mode: 'dry-run' | 'enforce';
  /** Security Hub control IDs about S3 buckets that are not blocking public access (e.g. `S3.8`). */
  readonly s3ControlIds: string[];
  /** Security Hub control IDs about security groups open to the internet on remote administration ports (e.g. `EC2.53`). */
  readonly sgControlIds: string[];
  /** Ports whose 0.0.0.0/0 and ::/0 ingress rules are revoked. Other rules are never touched. */
  readonly remoteAdminPorts: number[];
  /** Lowest GuardDuty severity that isolates an EC2 instance. */
  readonly guardDutyMinSeverity: 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /**
   * Reserved concurrency of the remediation function, which caps how many findings are handled at once. Leave it
   * unset in an account whose Lambda concurrency quota is at the default of 10: reserving any of it fails the
   * deployment (the account must keep 10 unreserved).
   */
  readonly reservedConcurrency?: number;
  /** A resource tagged with this key set to `true` is never remediated. */
  readonly skipTagKey: string;
  /**
   * Also act on findings imported with `BatchImportFindings` (product `Default`). Needed by the check script to
   * exercise the rules with real resources. Anyone who may import findings can then trigger a remediation, so keep
   * it off outside development.
   */
  readonly acceptImportedFindings: boolean;
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
  /** Automatic remediation of findings. */
  readonly remediation: RemediationParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
