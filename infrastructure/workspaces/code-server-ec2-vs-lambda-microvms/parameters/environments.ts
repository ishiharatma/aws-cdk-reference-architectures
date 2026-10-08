import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 *
 */
export interface Ec2Params {
  /** @default 't4g.medium' */
  readonly instanceType?: string;
  /** code-server release installed by UserData. @default '4.141.0' */
  readonly codeServerVersion?: string;
  /** @default 30 */
  readonly volumeSizeGiB?: number;
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
  /** code-server release baked into the image. @default '4.141.0' */
  readonly codeServerVersion?: string;
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
}

/**
 *
 */
export interface EnvParams extends EnvironmentConfig {
  readonly ec2?: Ec2Params;
  readonly microvm: MicrovmParams;
  readonly bedrock?: BedrockParams;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
