import { EnvParams } from 'lib/types/route53-phz-delegation-params';
import { params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';
import { NatType } from '@common/types/vpc';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Development Environment Parameters
 *
 * - HubVpc (10.0.0.0/16, 2 AZs): a "Private" isolated subnet group hosts the test instance
 *   and its SSM interface endpoints; a dedicated "Resolver" isolated /27 subnet group hosts
 *   the regular inbound + outbound Resolver endpoints; a dedicated "Tgw" isolated /28
 *   subnet group hosts the Transit Gateway attachment ENIs.
 * - DevVpc / StgVpc (10.1.0.0/16, 10.2.0.0/16, 2 AZs): no workload subnet needed - only
 *   "Resolver" (the INBOUND_DELEGATION endpoint) and "Tgw".
 * - OnPremVpc (10.3.0.0/16, 1 AZ): a "Private" isolated subnet hosts the BIND9 forwarder
 *   and its own SSM interface endpoints; "Tgw" for the attachment.
 * - No NAT Gateway and no Internet Gateway anywhere - every subnet is PRIVATE_ISOLATED.
 *   `dnf install` reaches the Amazon Linux package repos via the default S3 gateway
 *   endpoint; SSM Session Manager reaches its endpoints via the SSM/SSM Messages/EC2
 *   Messages interface endpoints created in the stack for HubVpc and OnPremVpc.
 */
const hubVpcSubnets = [
    { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
    { name: 'Resolver', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 27 },
    { name: 'Tgw', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 28 },
];

const childVpcSubnets = [
    { name: 'Resolver', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 27 },
    { name: 'Tgw', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 28 },
];

const onPremVpcSubnets = [
    { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
    { name: 'Tgw', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 28 },
];

const devParams: EnvParams = {
    // Region (profile default wins; falls back to Tokyo)
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',

    // Common tags
    tags: {},

    // DNS
    parentZoneName: 'system.example.com',
    devZoneName: 'dev.system.example.com',
    stgZoneName: 'stg.system.example.com',

    // Transit Gateway
    amazonSideAsn: 64512,

    // Hub VPC (parent zone owner)
    hubVpcConfig: {
        createConfig: {
            vpcName: 'HubVpc',
            cidr: '10.0.0.0/16',
            maxAzs: 2,
            natCount: 0,
            natType: NatType.GATEWAY,
            createInternetGateway: false,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            enableFlowLogsToCloudWatch: false, // Enable in production
            subnets: hubVpcSubnets,
        },
    },

    // Dev VPC (dev.system.example.com owner)
    devVpcConfig: {
        createConfig: {
            vpcName: 'DevVpc',
            cidr: '10.1.0.0/16',
            maxAzs: 2,
            natCount: 0,
            natType: NatType.GATEWAY,
            createInternetGateway: false,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            enableFlowLogsToCloudWatch: false,
            subnets: childVpcSubnets,
        },
    },

    // Stg VPC (stg.system.example.com owner)
    stgVpcConfig: {
        createConfig: {
            vpcName: 'StgVpc',
            cidr: '10.2.0.0/16',
            maxAzs: 2,
            natCount: 0,
            natType: NatType.GATEWAY,
            createInternetGateway: false,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            enableFlowLogsToCloudWatch: false,
            subnets: childVpcSubnets,
        },
    },

    // On-premises-role VPC
    onPremVpcConfig: {
        createConfig: {
            vpcName: 'OnPremVpc',
            cidr: '10.3.0.0/16',
            maxAzs: 1,
            natCount: 0,
            natType: NatType.GATEWAY,
            createInternetGateway: false,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            enableFlowLogsToCloudWatch: false,
            subnets: onPremVpcSubnets,
        },
    },
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
