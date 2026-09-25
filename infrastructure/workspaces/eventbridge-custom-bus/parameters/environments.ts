import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  /** Orders with `detail.amount` at or above this value are routed to the high-value queue. */
  readonly highValueThreshold: number;
  /** How long the archive keeps events available for replay. */
  readonly archiveRetentionDays: number;
  /** Maximum age of an event EventBridge keeps retrying to deliver to a target. */
  readonly targetMaxEventAgeMinutes: number;
  /** Retry attempts per target before the event goes to the target DLQ. */
  readonly targetRetryAttempts: number;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
