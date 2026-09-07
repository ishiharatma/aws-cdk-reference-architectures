import { params, EnvParams } from 'parameters/environments';
import { Environment } from "@common/parameters/environments";
import { NatType } from '@common/types';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Development Environment Parameters
 *
 * VPC layout:
 *   Public  (NAT Gateway, CloudFront VPC Origin ENIs)  /20
 *   Private (ALB + ECS Fargate)                        /20
 *   Isolated (Aurora PostgreSQL)                       /20
 */
const devParams: EnvParams = {
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',

    tags: {},

    vpcConfig: {
        createConfig: {
            vpcName: 'fis-chaos-vpc',
            cidr: '10.10.0.0/16',
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

    // CloudFront managed prefix list for ap-northeast-1
    cloudfrontManagedPrefixList: 'pl-58a04531',

    // alarmEmail: 'your@email.example.com',
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
