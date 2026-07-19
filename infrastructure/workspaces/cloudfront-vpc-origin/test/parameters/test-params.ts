import { params, EnvParams } from 'parameters/environments';
import { Environment } from "@common/parameters/environments";
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Test Environment Parameters
 */
const testParams: EnvParams = {
    region: 'ap-northeast-1',
    tags: {},
    vpcConfig: {
        createConfig: {
            vpcName: 'MyVpc',
            cidr: '10.0.0.0/16',
            maxAzs: 2,
            enableFlowLogsToCloudWatch: true,
            subnets: [
                {
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                },
                {
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 24,
                },
            ],
        }
    },
};

// Register in the params object
params[Environment.TEST] = testParams;
