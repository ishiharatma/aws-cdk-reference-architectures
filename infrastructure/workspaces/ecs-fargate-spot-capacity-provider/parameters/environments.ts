import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/** Fargate capacity providers. FARGATE_SPOT runs on spare capacity at a discount and can be interrupted. */
export type FargateCapacityProvider = 'FARGATE' | 'FARGATE_SPOT';

/**
 * One entry of the service's capacity provider strategy.
 *
 * `base` tasks are placed on the provider first; the remaining tasks are split by `weight`.
 * Only one entry may have a `base`.
 */
export interface CapacityProviderStrategyParams {
  readonly capacityProvider: FargateCapacityProvider;
  readonly base?: number;
  readonly weight: number;
}

/** Network settings. Three AZs give the rebalancer room to spread tasks evenly. */
export interface NetworkParams {
  readonly vpcCidr: string;
  readonly maxAzs: number;
  /** NAT gateways for task egress (image pulls, logs). 1 for dev, one per AZ for production. */
  readonly natGateways: number;
}

/** Target tracking auto scaling of the service. New tasks follow the same capacity provider strategy. */
export interface AutoScalingParams {
  readonly minCapacity: number;
  readonly maxCapacity: number;
  readonly targetCpuUtilizationPercent: number;
}

/** The web service behind the ALB. */
export interface ServiceParams {
  readonly desiredCount: number;
  readonly cpu: number;
  readonly memoryLimitMiB: number;
  readonly capacityProviderStrategies: CapacityProviderStrategyParams[];
  /**
   * Explicitly set because the service-side default is only applied at creation time:
   * a service created before the default changed keeps DISABLED until it is set.
   */
  readonly availabilityZoneRebalancing: 'ENABLED' | 'DISABLED';
  readonly minHealthyPercent: number;
  /** Must be above 100 for AZ rebalancing (it starts a task before stopping one). */
  readonly maxHealthyPercent: number;
  /** Seconds between SIGTERM and SIGKILL. Fargate caps it at 120, the length of the Spot warning. */
  readonly stopTimeoutSeconds: number;
  /** Seconds the application keeps serving after SIGTERM while it reports unhealthy. */
  readonly drainSeconds: number;
  /** ALB target deregistration delay. Keep it below the 120-second Spot warning. */
  readonly deregistrationDelaySeconds: number;
  readonly autoScaling: AutoScalingParams;
}

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  readonly network: NetworkParams;
  /** Container image with Python 3; the application in `src/app.py` is passed as the command. */
  readonly containerImage: string;
  readonly service: ServiceParams;
  /** Retention of the application logs and the captured Spot interruption events. */
  readonly logRetentionDays: number;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
