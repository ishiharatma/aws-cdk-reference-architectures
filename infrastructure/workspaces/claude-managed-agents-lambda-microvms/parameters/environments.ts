import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Identifiers issued by the Claude Console for the self_hosted environment.
 */
export interface AnthropicParams {
  /** Claude Console self_hosted environment ID (`env_...`). */
  readonly environmentId: string;
  /** Override the API base URL (for example, Claude Platform on AWS). @default Anthropic default */
  readonly baseUrl?: string;
}

/**
 * Where the two secrets live. CloudFormation cannot create SecureString parameters, so the stack only
 * grants access to the names below; the values are written with scripts/put-secrets.sh after deploy.
 */
export interface SecretsParams {
  /** @default `/<project>/<env>/anthropic/environment-key` */
  readonly environmentKeyParamName?: string;
  /** @default `/<project>/<env>/anthropic/webhook-signing-secret` */
  readonly signingParamName?: string;
  /** Encrypt both SecureStrings with a customer managed KMS key instead of alias/aws/ssm. @default false */
  readonly useCustomerManagedKey?: boolean;
}

export interface IdlePolicyParams {
  /** @default 600 */
  readonly maxIdleDurationSeconds?: number;
  /** @default 0 */
  readonly suspendedDurationSeconds?: number;
  /** @default false */
  readonly autoResumeEnabled?: boolean;
}

export interface MicrovmParams {
  /** AWS-managed base image, discover with `aws lambda-microvms list-managed-microvm-images`. */
  readonly baseImageArn: string;
  readonly baseImageVersion: string;
  /** @default 2048 */
  readonly minimumMemoryInMiB?: number;
  /** @default 'ARM_64' */
  readonly architecture?: string;
  /** Hard upper bound of one MicroVM's life. @default 14400 (4 hours) */
  readonly maxLifetimeSeconds?: number;
  readonly idlePolicy?: IdlePolicyParams;
}

export interface NetworkParams {
  /**
   * `internet`: AWS-managed INTERNET_EGRESS (same as the AWS reference implementation).
   * `firewall`: VPC egress connector, private subnet, Network Firewall domain allow list, NAT gateway.
   * @default 'internet'
   */
  readonly egressMode?: 'internet' | 'firewall';
  /**
   * `all`: AWS-managed ALL_INGRESS (same as the reference implementation).
   * `none`: AWS-managed NO_INGRESS; the worker only makes outbound calls.
   * @default 'all'
   */
  readonly ingressMode?: 'all' | 'none';
  /** Domains the firewall lets through (HTTP host / TLS SNI). Used when egressMode is `firewall`. */
  readonly allowedDomains?: string[];
  /** @default '10.60.0.0/24' */
  readonly vpcCidr?: string;
}

export interface OperationsParams {
  /** E-mail address subscribed to the alarm topic. */
  readonly alarmEmail?: string;
  /** A MicroVM still RUNNING after this many minutes counts as stale. @default 240 */
  readonly staleThresholdMinutes?: number;
  /** Monthly AWS Budgets limit in USD for resources tagged with this project. Omit to skip the budget. */
  readonly monthlyBudgetUsd?: number;
  /** @default 30 */
  readonly logRetentionDays?: number;
}

export interface EnvParams extends EnvironmentConfig {
  readonly anthropic: AnthropicParams;
  readonly secrets?: SecretsParams;
  readonly microvm: MicrovmParams;
  readonly network?: NetworkParams;
  readonly operations?: OperationsParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
