import { EnvParams } from 'lib/types/route53-phz-delegation-params';
import { params } from 'parameters/environments';
import { NatType } from '@common/types/vpc';
import { Environment } from '@common/parameters/environments';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Test Environment Parameters
 *
 * Static values (no env-var / network lookups) so snapshots stay deterministic.
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

const testParams: EnvParams = {
    region: 'us-east-1',
    tags: {
        Environment: Environment.TEST,
        Project: 'route53-phz-delegation-example',
        ManagedBy: 'CDK',
    },
    parentZoneName: 'system.example.com',
    devZoneName: 'dev.system.example.com',
    stgZoneName: 'stg.system.example.com',
    amazonSideAsn: 64512,
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
            enableFlowLogsToCloudWatch: false,
            subnets: hubVpcSubnets,
        },
    },
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
params[Environment.TEST] = testParams;
