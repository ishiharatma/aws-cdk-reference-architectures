import { VpcConfig } from '@common/types/vpc';

/**
 * VPC Peering Parameters
 */
export interface VpcPeeringParams {
  /**
   * AWS Account ID for Account A
   */
  readonly accountAId: string;

  /**
   * AWS Account ID for Account B (for cross-account peering)
   * If not specified, all VPCs are in the same account
   */
  readonly accountBId?: string;

  /**
   * AWS Region for Account A
   */
  readonly regionA?: string;

  /**
   * AWS Region for Account B (for cross-region peering)
   */
  readonly regionB?: string;

  /**
   * VPC A configuration in Account A
   */
  readonly vpcAConfig: VpcConfig;

  /**
   * VPC B configuration in Account A
   */
  readonly vpcBConfig: VpcConfig;

  /**
   * VPC C configuration in Account B
   */
  readonly vpcCConfig?: VpcConfig;

  /**
   * Stack name prefix
   */
  readonly stackNamePrefix?: string;

  /**
   * Common tags to apply to all resources
   */
  readonly tags?: Record<string, string>;
}

/**
 * Environment parameters type
 */
export type EnvParams = VpcPeeringParams;
