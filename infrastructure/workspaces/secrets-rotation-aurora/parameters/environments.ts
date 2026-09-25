import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  /** Aurora Serverless v2 minimum capacity (ACU). */
  readonly minCapacity: number;
  /** Aurora Serverless v2 maximum capacity (ACU). */
  readonly maxCapacity: number;
  /** Rotation schedule for both secrets, in days. */
  readonly rotationDays: number;
  /** Application database user whose secret uses alternating-user rotation. */
  readonly appUsername: string;
  /** Default database created in the cluster. */
  readonly databaseName: string;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
