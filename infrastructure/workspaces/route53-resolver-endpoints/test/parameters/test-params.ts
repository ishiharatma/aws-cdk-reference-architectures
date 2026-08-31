import { EnvParams } from 'lib/types/route53-resolver-endpoints-params';
import { params } from 'parameters/environments';
import { NatType } from '@common/types/vpc';
import { Environment } from '@common/parameters/environments';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Test Environment Parameters
 *
 * Static values (no env-var / network lookups) so snapshots stay deterministic.
 */
const verifyVpcSubnets = [
    { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
    { name: 'Resolver', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 27 },
];

const onPremVpcSubnets = [{ name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }];

const testParams: EnvParams = {
    region: 'us-east-1',
    tags: {
        Environment: Environment.TEST,
        Project: 'route53-resolver-endpoints-example',
        ManagedBy: 'CDK',
    },
    privateHostedZoneName: 'system.example.com',
    onPremDomainName: 'onprem.example.com',
    inboundEndpointType: 'DEFAULT',
    verifyVpcConfig: {
        createConfig: {
            vpcName: 'VerifyVpc',
            cidr: '10.10.0.0/16',
            maxAzs: 2,
            natCount: 0,
            natType: NatType.GATEWAY,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            enableFlowLogsToCloudWatch: false,
            subnets: verifyVpcSubnets,
        },
    },
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
params[Environment.TEST] = testParams;
