import { CollectorParams, NotificationParams, ReportParams, ScheduleParams } from 'lib/types';
import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Environment parameters type for aws-eol-monitor
 */
export interface EnvParams extends EnvironmentConfig {
  /** Where to fetch the EOL dataset from, and what counts as "upcoming". */
  readonly collector: CollectorParams;
  /** How often the check runs. */
  readonly schedule: ScheduleParams;
  /** Bedrock model used to draft the natural-language digest. */
  readonly report: ReportParams;
  /** Notification targets for the digest. */
  readonly notification: NotificationParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
