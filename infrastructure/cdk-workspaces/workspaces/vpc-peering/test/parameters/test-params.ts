import { EnvParams } from 'lib/types/vpc-peering-params';
import { NatType } from '@common/types/vpc';
import { params } from 'parameters/environments';
import { Environment } from "@common/parameters/environments";
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Development Environment Parameters
 * 
 * This configuration creates:
 * - VPC A (10.0.0.0/16) in Account A
 * - VPC B (10.1.0.0/16) in Account A
 * - VPC C (10.2.0.0/16) in Account B (optional - comment out if not needed)
 * 
 * Peering connections:
 * - VPC A <-> VPC B (same account)
 * - VPC B <-> VPC C (cross account - if VPC C is configured)
 */
const testParams: EnvParams = {
  // Account IDs
  accountAId: '111111111111', // Replace with actual Account A ID
  accountBId: '222222222222', // Replace with actual Account B ID if needed

  // Regions
  regionA: 'ap-northeast-1',
  regionB: 'ap-northeast-1', // Set if cross-region peering is needed

  // Stack name prefix
  stackNamePrefix: 'vpc-peering-dev',

  // Common tags
  tags: {
    Environment: Environment.TEST,
    Project: 'vpc-peering-example',
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
params[Environment.TEST] = testParams;