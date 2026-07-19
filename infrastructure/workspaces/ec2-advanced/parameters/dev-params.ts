import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { params, EnvParams } from 'parameters/environments';
import { NatType } from '@common/types';
import { Environment } from "@common/parameters/environments";
import { nginxSamplePageUserData } from 'src/nginx-userdata';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
    // Account ID
    //accountId: process.env.CDK_DEFAULT_ACCOUNT || '111111111111', // if you want to specify
    
    // Regions
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',

    // Stack name prefix
    stackNamePrefix: 'ec2-advanced',

    // Common tags
    tags: {},

    // VPC Configuration
    vpcConfig: {
        //existingVpcId: undefined, // Set VPC ID if using existing VPC
        createConfig: {
            vpcName: 'MyVpc',
            cidr: '10.0.0.0/16',
            maxAzs: 2,
            natCount: 1,
            natType: NatType.INSTANCE,
            subnets: [
                {
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                },
                {
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                    cidrMask: 24,
                },
            ],
            natSchedule: {
                startCronSchedule: 'cron(0 18 * * ? *)', // Start at 18:00 JST daily
                stopCronSchedule: 'cron(0 21 * * ? *)', // Stop at 21:00 JST daily
                timeZone: cdk.TimeZone.ASIA_TOKYO,
            },
        }
    },

    // EC2 instance configuration
    ec2Config: {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
        rootVolumeSize: 8,
        additionalUserData: nginxSamplePageUserData(),
    },

    // Ports allowed from ALB to EC2 (used for ASG patterns)
    ports: [80],
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
