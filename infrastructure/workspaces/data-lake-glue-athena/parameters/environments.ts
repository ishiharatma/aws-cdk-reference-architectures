import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  /** Glue worker type of the ETL job. */
  readonly glueWorkerType: 'G.1X' | 'G.2X';
  /** Number of workers of the ETL job (at least 2). */
  readonly glueNumberOfWorkers: number;
  /** Glue version of the ETL job. */
  readonly glueVersion: '4.0' | '5.0';
  /**
   * Cron expression that starts the whole workflow (crawl, convert, crawl). Leave it undefined for on-demand runs only:
   * each crawler run is billed with a 10-minute minimum, so a schedule that is not needed is a cost.
   */
  readonly workflowSchedule?: string;
  /** Athena workgroup: a query that would scan more than this many bytes is cancelled (minimum 10 MB). */
  readonly athenaBytesScannedCutoff: number;
  /** Days to keep Athena query results. */
  readonly athenaResultsExpirationDays: number;
  /** Days to keep the Glue job logs. */
  readonly logRetentionDays: number;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
