import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';
import { NatType } from '@common/types';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

const testParams: EnvParams = {
    region: 'ap-northeast-1',
    tags: {},
    vpcConfig: {
        createConfig: {
            vpcName: 'fis-chaos-g-vpc',
            cidr: '10.70.0.0/16',
            maxAzs: 2,
            natCount: 1,
            natType: NatType.GATEWAY,
            subnets: [
                { subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24, name: 'Public' },
                { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24, name: 'Private' },
                { subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24, name: 'Isolated' },
            ],
        },
    },
};

params[Environment.TEST] = testParams;
