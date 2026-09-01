import { EnvParams } from 'lib/types/route53-resolver-endpoints-params';
import { params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';
import { NatType } from '@common/types/vpc';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Development Environment Parameters
 *
 * - VerifyVpc (10.10.0.0/16, 2 AZs): a "Private" isolated /24 subnet group hosts the test
 *   instance and the SSM interface endpoints (SSM Session Manager access with no internet
 *   route at all); the dedicated "Resolver" isolated /27 subnet group hosts the Resolver
 *   in/outbound endpoint ENIs.
 * - OnPremVpc (10.20.0.0/16, 1 AZ): a single "Private" isolated subnet hosts the BIND9
 *   instance and its own SSM interface endpoints.
 * - No NAT Gateway and no Internet Gateway anywhere - every subnet is PRIVATE_ISOLATED.
 *   `dnf install` reaches the Amazon Linux package repos via the default S3 gateway
 *   endpoint (added automatically by VpcConstruct); SSM Session Manager reaches its
 *   endpoints via the SSM/SSM Messages/EC2 Messages interface endpoints created in the
 *   stack.
 */
const verifyVpcSubnets = [
    {
        name: 'Private',
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
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
        name: 'Private',
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
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
    inboundEndpointType: 'DELEGATION',

    // Verification VPC
    verifyVpcConfig: {
        createConfig: {
            vpcName: 'VerifyVpc',
            cidr: '10.10.0.0/16',
            maxAzs: 2,
            natCount: 0,
            natType: NatType.GATEWAY,
            createInternetGateway: false,
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
