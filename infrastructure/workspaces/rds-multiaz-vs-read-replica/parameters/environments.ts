import { Environment, EnvironmentConfig } from '@common/parameters/environments';
import { VpcConfig } from '@common/types';

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  /** VPC for the databases and the probe (isolated subnets only; Secrets Manager is reached through an endpoint). */
  readonly vpcConfig: VpcConfig;
  /** Instance class of the Multi-AZ primary and of the read replica. */
  readonly dbInstanceClass: string;
  /** Allocated storage of the primary in GiB. A read replica inherits at least this size. */
  readonly allocatedStorage: number;
  /**
   * CloudWatch alarm threshold on the replica's lag, in seconds. The ReplicaLag metric is the time since the last replayed
   * transaction, and the stack's heartbeat writes once a minute, so the metric sits near 50 s even when replication is
   * instant. The threshold must be clearly above the heartbeat interval (60 s), or the alarm fires on a healthy replica.
   */
  readonly replicaLagAlarmSeconds: number;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
