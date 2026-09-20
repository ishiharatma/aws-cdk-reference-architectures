import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';
import { NatType } from '@common/types';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Development Environment Parameters
 *
 * VPC layout (2 AZs — required for the AZ-isolation experiment H-1):
 *   Public   (NAT Gateway)                              /24 x2
 *   Private  (EC2 Auto Scaling Group, one per AZ)        /24 x2
 *   Isolated (Aurora PostgreSQL, Multi-AZ)               /24 x2
 */
const devParams: EnvParams = {
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',

    tags: {},

    // 'ReplaceUnhealthy' is the default that demonstrates capacity actually
    // moving to the healthy AZ during a zonal shift (see FisStack docstring).
    // Switch to 'IgnoreUnhealthy' + redeploy to compare AWS's "prescaled"
    // recommendation (no replacement churn at all) instead.
    impairedZoneHealthCheckBehavior: 'ReplaceUnhealthy',

    vpcConfig: {
        createConfig: {
            vpcName: 'fis-chaos-h-vpc',
            cidr: '10.80.0.0/16',
            maxAzs: 2,
            natCount: 1,
            natType: NatType.GATEWAY,
            subnets: [
                {
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                    name: 'Public',
                },
                {
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                    cidrMask: 24,
                    name: 'Private',
                },
                {
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 24,
                    name: 'Isolated',
                },
            ],
        },
    },

    // alarmEmail: 'your@email.example.com',
};

params[Environment.DEVELOPMENT] = devParams;
