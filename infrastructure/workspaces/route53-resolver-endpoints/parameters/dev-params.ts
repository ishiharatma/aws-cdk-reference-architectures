import { EnvParams } from 'lib/types/route53-resolver-endpoints-params';
import { params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';
import { NatType } from '@common/types/vpc';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Development Environment Parameters
 *
 * - VerifyVpc (10.10.0.0/16, 2 AZs): "Public" subnets host the test instance (Internet
 *   Gateway reachable, no NAT needed for SSM Session Manager); the dedicated "Resolver"
 *   isolated /27 subnets host the Resolver in/outbound endpoint ENIs.
 * - OnPremVpc (10.20.0.0/16, 1 AZ): a single "Public" subnet hosts the BIND9 instance.
 * - No NAT Gateway anywhere - this workspace only needs outbound internet access for the
 *   test/BIND9 instances' package installs and SSM, which the Internet Gateway covers.
 */
const verifyVpcSubnets = [
    {
        name: 'Public',
        subnetType: ec2.SubnetType.PUBLIC,
        cidrMask: 24,
    },
    {
        name: 'Resolver',
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        cidrMask: 27,
    },
];

const onPremVpcSubnets = [
    {
        name: 'Public',
        subnetType: ec2.SubnetType.PUBLIC,
        cidrMask: 24,
    },
];

const devParams: EnvParams = {
    // Region (profile default wins; falls back to Tokyo)
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',

    // Common tags
    tags: {},

    // DNS
    privateHostedZoneName: 'system.example.com',
    onPremDomainName: 'onprem.example.com',
    inboundEndpointType: 'DEFAULT',

    // Verification VPC
    verifyVpcConfig: {
        createConfig: {
            vpcName: 'VerifyVpc',
            cidr: '10.10.0.0/16',
            maxAzs: 2,
            natCount: 0,
            natType: NatType.GATEWAY,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            enableFlowLogsToCloudWatch: false, // Enable in production
            subnets: verifyVpcSubnets,
        },
    },

    // On-premises-role VPC
    onPremVpcConfig: {
        createConfig: {
            vpcName: 'OnPremVpc',
            cidr: '10.20.0.0/16',
            maxAzs: 1,
            natCount: 0,
            natType: NatType.GATEWAY,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            enableFlowLogsToCloudWatch: false,
            subnets: onPremVpcSubnets,
        },
    },
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
