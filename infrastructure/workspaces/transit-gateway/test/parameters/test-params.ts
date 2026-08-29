import { EnvParams } from 'lib/types/transit-gateway-params';
import { params } from 'parameters/environments';
import { NatType } from '@common/types/vpc';
import { Environment } from '@common/parameters/environments';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Test Environment Parameters
 *
 * Static values (no env-var / network lookups) so snapshots stay deterministic.
 * VPC A 10.0.0.0/16, VPC B 10.1.0.0/16, VPC C 10.2.0.0/16, each with a public subnet
 * and a dedicated /28 "Tgw" subnet per AZ for the Transit Gateway attachment.
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

const testParams: EnvParams = {
    region: 'us-east-1',
    amazonSideAsn: 64512,
    connectedNetworkCidr: '10.0.0.0/8',
    tags: {
        Environment: Environment.TEST,
        Project: 'transit-gateway-example',
        ManagedBy: 'CDK',
    },
    vpcAConfig: {
        createConfig: {
            vpcName: 'VpcA',
            cidr: '10.0.0.0/16',
            maxAzs: 2,
            natCount: 0,
            natType: NatType.GATEWAY,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            enableFlowLogsToCloudWatch: false,
            subnets: vpcSubnets,
        },
    },
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
params[Environment.TEST] = testParams;
