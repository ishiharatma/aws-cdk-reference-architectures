import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as types from 'lib/types';
import { params, EnvParams } from 'parameters/environments';

// Development environment parameters
const prdParams: EnvParams = {
    accountId: '111122223333',
    vpcConfig: {
        createConfig: {
            vpcName: 'PrdVPC',
            cidr: '10.12.0.0/16',
            maxAzs: 3,
            natCount: 3,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            subnets: [
                {
                    subnetType: ec2.SubnetType.PUBLIC,
                    name: 'Public',
                    cidrMask: 24,
                },
                {
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                    name: 'Private',
                    cidrMask: 24,
                },
            ],
        },
    },
};

// Register in the params object
params[types.Environment.PRODUCTION] = prdParams;