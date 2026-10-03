import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  /** Name of the private hosted zone. */
  readonly zoneName: string;
  /** Record name inside the zone (the name clients resolve). */
  readonly recordName: string;
  /** TTL of the failover records in seconds. */
  readonly recordTtl: number;
  /** Seconds between health checks (10 = fast, 30 = standard). */
  readonly healthCheckIntervalSeconds: 10 | 30;
  /** Consecutive failures before an endpoint is marked unhealthy. */
  readonly healthCheckFailureThreshold: number;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
