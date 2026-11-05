import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Per-user EC2 compute. Omit `ec2` to deploy MicroVM sessions only (no VPC, no NAT Gateway).
 */
export interface Ec2Params {
  /** @default 't4g.medium' */
  readonly instanceType?: string;
  /** @default 30 */
  readonly volumeSizeGiB?: number;
  /** A running instance is stopped this many hours after its last start. @default 8 */
  readonly maxRunningHours?: number;
  /**
   * Outbound path of the private subnets. 'gateway' is managed and scales by itself; 'instance' costs
   * far less but is one instance you patch, with no failover and a burst-limited network.
   * @default 'gateway'
   */
  readonly natType?: 'gateway' | 'instance';
  /**
   * Used only when natType is 'instance'; must be arm64 for the default image. Do not use a nano size:
   * the boot-time package install runs out of memory on 512 MiB and NAT is never configured.
   * @default 't4g.micro'
   */
  readonly natInstanceType?: string;
}

/**
 *
 */
export interface MicrovmParams {
  /** AWS-managed base image, discover with `aws lambda-microvms list-managed-microvm-images`. */
  readonly baseImageArn: string;
  readonly baseImageVersion: string;
  /** @default 2048 */
  readonly minimumMemoryInMiB?: number;
  /** @default 'ARM_64' */
  readonly architecture?: string;
  /** Idle seconds before suspend. @default 900 */
  readonly maxIdleSeconds?: number;
  /** Seconds a suspended MicroVM is kept. @default 3600 */
  readonly suspendedSeconds?: number;
  /** Total lifetime in seconds, running plus suspended. Service maximum is 28800. @default 28800 */
  readonly maximumDurationSeconds?: number;
  /** Lifetime of the endpoint token. Service maximum is 60. @default 60 */
  readonly authTokenMinutes?: number;
}

/**
 *
 */
export interface ControlPlaneParams {
  /** Sessions one user may hold at once, across compute types. @default 2 */
  readonly maxActiveSessionsPerOwner?: number;
  /** DynamoDB TTL of a session record, also the deadline for a stopped EC2 instance. @default 1 */
  readonly sessionRecordTtlDays?: number;
}

/**
 * CodeCommit repositories reachable from sessions, in the deployment's account and Region.
 */
export interface CodeCommitParams {
  /** Existing repositories. The stacks only grant access to them. @default [] */
  readonly repositoryNames?: string[];
  /** Repositories this application creates, and deletes along with its stacks. @default [] */
  readonly managedRepositoryNames?: string[];
}

/**
 *
 */
export interface BedrockParams {
  /** Install Claude Code (CLI + VS Code extension) configured for Amazon Bedrock. @default true */
  readonly enabled?: boolean;
  /** Inference profile ID, verify with `aws bedrock-runtime converse` first. @default 'jp.anthropic.claude-sonnet-4-6' */
  readonly modelId?: string;
  /** @default 'jp.anthropic.claude-haiku-4-5-20251001-v1:0' */
  readonly smallFastModelId?: string;
  /** Log a one-line Claude Code call at each MicroVM start, for troubleshooting. Spends tokens. @default false */
  readonly smokeCheck?: boolean;
}

/**
 *
 */
export interface EnvParams extends EnvironmentConfig {
  readonly microvm: MicrovmParams;
  readonly ec2?: Ec2Params;
  readonly controlPlane?: ControlPlaneParams;
  readonly bedrock?: BedrockParams;
  readonly codeCommit?: CodeCommitParams;
  /** Publish the browser-only access path (CloudFront + Lambda@Edge in us-east-1). @default true */
  readonly browserAccess?: boolean;
  /** code-server release used by both compute types. @default '4.141.0' */
  readonly codeServerVersion?: string;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
