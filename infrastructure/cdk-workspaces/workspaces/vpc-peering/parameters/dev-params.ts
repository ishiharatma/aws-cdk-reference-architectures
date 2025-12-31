import { EnvParams } from 'lib/types/vpc-peering-params';
import { params } from 'parameters/environments';
import { NatType } from '@common/types/vpc';
import { Environment } from "@common/parameters/environments";
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Development Environment Parameters
 * 
 * This configuration creates:
 * - VPC A (10.0.0.0/16) in Account A
 * - VPC B (10.1.0.0/16) in Account A
 * - VPC C (10.2.0.0/16) in Account B
 * 
 * Peering connections:
 * - VPC A <-> VPC B (same account)
 * - VPC B <-> VPC C (cross account - if VPC C is configured)
 */
const devParams: EnvParams = {
  // Account IDs
  accountAId: process.env.CDK_DEFAULT_ACCOUNT || '111111111111', // Replace with actual Account A ID
  accountBId: process.env.CDK_CROSS_ACCOUNT_ID || undefined, // Replace with actual Account B ID if needed

  // Regions
  regionA: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  regionB: process.env.CDK_CROSS_REGION || 'ap-northeast-1',

  // Stack name prefix
  stackNamePrefix: 'vpc-peering-dev',

  // Common tags
  tags: {
    ManagedBy: 'CDK',
  },

  // VPC A Configuration
  vpcAConfig: {
    createConfig: {
        vpcName: 'VpcA',
        cidr: '10.0.0.0/16',
        maxAzs: 2,
        natCount: 1,
        natType: NatType.GATEWAY,
        enableDnsHostnames: true,
        enableDnsSupport: true,
        enableFlowLogsToCloudWatch: false, // Enable if needed
        subnets: [
            {
                name: 'Public',
                subnetType: ec2.SubnetType.PUBLIC,
                cidrMask: 24,
            },
            {
                name: 'Private',
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                cidrMask: 24,
            },
        ],
    },
  },

  // VPC B Configuration
  vpcBConfig: {
    createConfig: {
        vpcName: 'VpcB',
        cidr: '10.1.0.0/16',
        maxAzs: 2,
        natCount: 1,
        natType: NatType.GATEWAY,
        enableDnsHostnames: true,
        enableDnsSupport: true,
        enableFlowLogsToCloudWatch: false,
        subnets: [
            {
                name: 'Public',
                subnetType: ec2.SubnetType.PUBLIC,
                cidrMask: 24,
            },
            {
                name: 'Private',
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                cidrMask: 24,
            },
        ],
    },
  },

  // VPC C Configuration (in Account B)
  // Comment out this section if you don't need cross-account peering
  vpcCConfig: {
    createConfig: {
        vpcName: 'VpcC',
        cidr: '10.2.0.0/16',
        maxAzs: 2,
        natCount: 0, // No NAT Gateway for cost savings
        natType: NatType.GATEWAY,
        enableDnsHostnames: true,
        enableDnsSupport: true,
        enableFlowLogsToCloudWatch: false,
        subnets: [
            {
                name: 'Private',
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                cidrMask: 24,
            },
        ],
    },
  },
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;