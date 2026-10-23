import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/** Access type of a gateway. `internet-facing` gateways are PUBLIC, `internal` ones PRIVATE. */
export type GatewayAccessType = 'PUBLIC' | 'PRIVATE';

/** HTTP desync mitigation mode of the gateway-managed ALBs. */
export type HttpDesyncMode = 'monitor' | 'defensive' | 'strictest';

/** IP address type of the gateway-managed ALBs (immutable after creation). */
export type GatewayIpAddressType = 'ipv4' | 'dualstack' | 'dualstack-without-public-ipv4';

/** Settings shared by both gateways (platform team). */
export interface GatewayParams {
  /** Upper bound of ALBs the gateway may create (25 services per ALB). Default of the service is 10. */
  readonly maxAlbCount: number;
  readonly httpDesync: HttpDesyncMode;
  readonly ipAddressType: GatewayIpAddressType;
  /** Deletion protection of the gateway and its ALBs. Must be false for `cdk destroy`. */
  readonly deletionProtection: boolean;
}

/** Header that routes requests to the new revision during a CANARY / BLUE_GREEN deployment. */
export interface TestTrafficHeader {
  readonly name: string;
  readonly values: string[];
}

/** Platform team settings: one internet-facing and one internal gateway on the same cluster. */
export interface PlatformParams {
  readonly vpcCidr: string;
  /** NAT gateways for task egress (image pulls, logs). 1 is enough for a dev environment. */
  readonly natGateways: number;
  readonly publicGateway: GatewayParams & {
    /** Inbound security group with only `allowedIps` on 443 instead of the ECS-managed 0.0.0.0/0 rule. */
    readonly restrictIngressToAllowedIps: boolean;
    /** Enable ALB access logs to an S3 bucket created by the platform stack. */
    readonly accessLogs: boolean;
    /** Requests per 5 minutes per client IP before the WAF rate rule blocks. */
    readonly wafRateLimit: number;
  };
  readonly privateGateway: GatewayParams;
  readonly testTrafficHeader: TestTrafficHeader;
}

/** Deployment strategy of an application service. ROLLING cannot change the connector health check later. */
export type ServiceDeploymentStrategy = 'ROLLING' | 'BLUE_GREEN' | 'CANARY';

/** One application team's service. */
export interface AppServiceParams {
  /** Service name (also used in the response body). */
  readonly name: string;
  /**
   * Gateway access types this service accepts. Omit to accept every compatible gateway: the service
   * then also connects to an internet-facing gateway that is associated later.
   */
  readonly accessTypes?: GatewayAccessType[];
  readonly desiredCount: number;
  readonly deploymentStrategy: ServiceDeploymentStrategy;
  /** CANARY only: percentage of production traffic shifted first, and how long it stays there. */
  readonly canary?: { readonly stepPercent: number; readonly bakeMinutes: number };
  /** Minutes the old revision is kept after the production shift (BLUE_GREEN / CANARY). */
  readonly bakeTimeMinutes?: number;
}

/** Application team settings. */
export interface AppParams {
  /** Container image answering HTTP on port 80 (nginx is used to print a small JSON body). */
  readonly containerImage: string;
  /** Value returned as `version`. Changing it starts a deployment of every service. */
  readonly version: string;
  readonly services: AppServiceParams[];
}

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  readonly platform: PlatformParams;
  readonly app: AppParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
