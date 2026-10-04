import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  /** Region that serves traffic in normal operation. */
  readonly primaryRegion: string;
  /** Disaster recovery region. */
  readonly drRegion: string;
  /** CIDR block of the VPC that hosts the private hosted zone and the resolver probe. */
  readonly vpcCidr: string;
  /** TTL of the DNS records in seconds. */
  readonly recordTtl: number;
  /** Seconds between health checks (10 = fast, 30 = standard). */
  readonly healthCheckIntervalSeconds: 10 | 30;
  /** Consecutive failures before an endpoint is marked unhealthy. */
  readonly healthCheckFailureThreshold: number;
  /** Warm standby: reserved concurrency of the standby Lambda (0 = scaled to zero, throttles all calls). */
  readonly warmStandbyConcurrency: number;
  /** Backup and restore: cron expression of the backup rule (AWS Backup cron syntax). */
  readonly backupScheduleCron: string;
  /** Backup and restore: days to keep recovery points in each vault. */
  readonly backupRetentionDays: number;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
