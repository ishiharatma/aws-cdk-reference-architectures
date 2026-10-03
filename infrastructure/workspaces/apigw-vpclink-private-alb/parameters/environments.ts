import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  /** CIDR block of the VPC. */
  readonly vpcCidr: string;
  /** Number of NAT gateways (1 is enough for a reference; use one per AZ for production). */
  readonly natGateways: number;
  /** Number of Fargate tasks behind the ALB. */
  readonly desiredCount: number;
  /** API Gateway usage plan: steady-state requests per second. */
  readonly apiRateLimit: number;
  /** API Gateway usage plan: burst. */
  readonly apiBurstLimit: number;
  /** API Gateway usage plan: requests per day. */
  readonly apiDailyQuota: number;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
