import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Web Function settings. Revision-level values (runtime, timeout, concurrency,
 * debug routes) live on the immutable revision, so changing them creates a new
 * revision; endpoint-level values (scaling, throttle) update in place.
 */
export interface WebFunctionParams {
  /** Requests served concurrently by one execution environment (1-128, default 64). */
  readonly maxConcurrencyPerEnvironment: number;
  /** Per-request timeout in seconds (3-900). */
  readonly timeoutSeconds: number;
  /** Upper bound of execution environments per Region (>= 2). Caps cost and downstream load. */
  readonly maxEnvironments: number;
  /** Endpoint-wide request rate limit (RPS). 0 rejects all requests; otherwise 100-1000 step 100, 2000-10000 step 1000. */
  readonly rateLimit: number;
  /** Mount the /debug diagnostic routes used by test-api.sh. Keep false outside dev. */
  readonly enableDebugRoutes: boolean;
}

/** Optional VPC egress through an `AWS::Lambda::NetworkConnector`. */
export interface VpcEgressParams {
  /** Route the revision's outbound traffic through an isolated VPC (DynamoDB gateway endpoint only). */
  readonly enabled: boolean;
  /** Availability Zones for the connector subnets. */
  readonly maxAzs: number;
}

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  readonly webFunction: WebFunctionParams;
  readonly vpcEgress: VpcEgressParams;
  /** WAF rate-based rule: requests per client IP per 60 seconds before blocking. */
  readonly wafRateLimitPerIp: number;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
