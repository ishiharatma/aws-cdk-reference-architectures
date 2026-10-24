import {
  CurParams,
  DeliveryParams,
  RetentionParams,
  ScheduleParams,
  SecurityParams,
  SummaryParams,
  TargetParams,
} from 'lib/types';
import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Environment parameters type for aws-environment-report
 */
export interface EnvParams extends EnvironmentConfig {
  /** Regions to collect from (must include us-east-1). */
  readonly target: TargetParams;
  /** Daily schedule window and CUR finalization deadline. */
  readonly schedule: ScheduleParams;
  /** CUR 2.0 export location. Omit to run without cost data. */
  readonly cur?: CurParams;
  /** Security collectors settings. */
  readonly security: SecurityParams;
  /** Bedrock summary settings. */
  readonly summary: SummaryParams;
  /** Report publishing mode. */
  readonly delivery: DeliveryParams;
  /** Data bucket retention. */
  readonly retention: RetentionParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
