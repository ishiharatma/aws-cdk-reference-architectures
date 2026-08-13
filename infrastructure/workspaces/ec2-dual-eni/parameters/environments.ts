import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Environment, EnvironmentConfig } from '@common/parameters/environments';

export interface EnvParams extends EnvironmentConfig {
  /**
   * CIDRs allowed to SSH into the management ENI (eth1).
   * In production, restrict this to your corporate VPN or on-premises CIDR.
   */
  readonly managementAllowedCidrs: string[];
  /** EC2 instance type. @default t4g.micro */
  readonly instanceType?: ec2.InstanceType;
  /** Root EBS volume size in GiB. @default 8 */
  readonly rootVolumeSize?: number;
}

export const params: Partial<Record<Environment, EnvParams>> = {};
