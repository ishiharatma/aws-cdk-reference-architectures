import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  /** CIDR of the VPC (public subnets only; tasks get public IPs, so there is no NAT gateway). */
  readonly vpcCidr: string;
  /** Number of Fargate tasks per service. */
  readonly desiredCount: number;
  /** Container image of the sample application (the version is a task definition environment variable). */
  readonly containerImage: string;
  /** Native blue/green: minutes the old (blue) tasks are kept after the production traffic shift, so a rollback is instant. */
  readonly nativeBakeMinutes: number;
  /** CodeDeploy: minutes the old (blue) task set is kept after the production traffic shift. */
  readonly codeDeployTerminationWaitMinutes: number;
  /** Seconds the sample lifecycle hook waits before it answers, to leave a window to look at the test listener. */
  readonly hookDelaySeconds: number;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
