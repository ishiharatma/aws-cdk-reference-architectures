import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { VpcConfig } from '@common/types';
import { Environment, EnvironmentConfig  } from "@common/parameters/environments";

/**
 * EC2 instance configuration shared across patterns
 */
export interface Ec2Config {
  /** EC2 instance type. @default ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO) */
  readonly instanceType?: ec2.InstanceType;
  /** Root EBS volume size in GiB. @default 8 */
  readonly rootVolumeSize?: number;
  /** Additional user data commands to execute on instance launch. */
  readonly additionalUserData?: string[];
}

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
    readonly vpcConfig: VpcConfig;
    /** EC2 instance configuration */
    readonly ec2Config?: Ec2Config;
    /**
     * Ports to allow from ALB to EC2 security group.
     * Used for ASG patterns (ALB → EC2).
     * @default [80]
     */
    readonly ports?: number[];
    /** Allowed IP CIDRs for ALB ingress. If omitted, allows all IPv4. */
    readonly allowedIpsforAlb?: string[];
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};