import { EnvParams } from 'lib/types/transit-gateway-params';
import { params } from 'parameters/environments';
import { NatType } from '@common/types/vpc';
import { Environment } from '@common/parameters/environments';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Development Environment Parameters
 *
 * Mirrors the AWS "One to Many: Evolving VPC Design" Transit Gateway lab:
 * - VPC A (10.0.0.0/16), VPC B (10.1.0.0/16), VPC C (10.2.0.0/16) in one account / region
 * - Each VPC: a public subnet for the test instance and a dedicated /28 "Tgw" subnet
 *   (PRIVATE_ISOLATED) per AZ for the Transit Gateway attachment ENIs
 * - No NAT Gateway; the test instances sit in the public subnet and reach Systems
 *   Manager / the internet through the Internet Gateway
 *
 * The lab runs in us-east-1 (N. Virginia); the profile's region still wins at deploy
 * time via CDK_DEFAULT_REGION, matching the other workspaces in this repository.
 */
const vpcSubnets = [
    {
        name: 'Public',
        subnetType: ec2.SubnetType.PUBLIC,
        cidrMask: 24,
    },
    {
        name: 'Tgw',
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        cidrMask: 28,
    },
];

const devParams: EnvParams = {
    // Region (profile default wins; falls back to the lab's region)
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',

    // Transit Gateway
    amazonSideAsn: 64512,
    connectedNetworkCidr: '10.0.0.0/8',

    // Common tags
    tags: {},

    // VPC A
    vpcAConfig: {
        createConfig: {
            vpcName: 'VpcA',
            cidr: '10.0.0.0/16',
            maxAzs: 2,
            natCount: 0,
            natType: NatType.GATEWAY,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            enableFlowLogsToCloudWatch: false, // Enable in production
            subnets: vpcSubnets,
        },
    },

    // VPC B
    vpcBConfig: {
        createConfig: {
            vpcName: 'VpcB',
            cidr: '10.1.0.0/16',
            maxAzs: 2,
            natCount: 0,
            natType: NatType.GATEWAY,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            enableFlowLogsToCloudWatch: false,
            subnets: vpcSubnets,
        },
    },

    // VPC C
    vpcCConfig: {
        createConfig: {
            vpcName: 'VpcC',
            cidr: '10.2.0.0/16',
            maxAzs: 2,
            natCount: 0,
            natType: NatType.GATEWAY,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            enableFlowLogsToCloudWatch: false,
            subnets: vpcSubnets,
        },
    },
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
