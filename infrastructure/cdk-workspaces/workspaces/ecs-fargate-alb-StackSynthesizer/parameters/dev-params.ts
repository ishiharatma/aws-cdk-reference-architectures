import * as cdk from 'aws-cdk-lib';
import { params, EnvParams } from 'parameters/environments';
import { NatType } from '@common/types';
import { Environment } from "@common/parameters/environments";
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
    // Account ID
    //accountId: process.env.CDK_DEFAULT_ACCOUNT || '111111111111', // if you want to specify
    
    // Regions
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',

    // Stack name prefix
    stackNamePrefix: 'ecs-fargate-alb',

    // Common tags
    tags: {},
    // VCP Configuration
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
    //hostedZoneId: 'hogehoge', // Optional: Route53 Hosted Zone ID for ALB DNS record
    // ECS Fargate with ALB Configuration
    ecsFargateConfig: {
        createConfig: {
            capacityProviderStrategies: {
                fargateSpotWeight:1,
                //fargateWeight:1,
            },
            desiredCount: 1,
            taskDefinition: [
                {
                    cpu: 512,
                    memoryLimitMiB: 1024,
                    containerDefinitions: {
                        "backend": {
                            cpu: 256,
                            memoryLimitMiB: 512,
                            port: 8080,
                            enabledXraySidecar: false,
                            enabledOtelSidecar: true,
                            environment: {
                                LOG_LEVEL: 'INFO',
                            },
                            healthCheck: {
                                path: '/health',
                                interval: cdk.Duration.seconds(30),
                                timeout: cdk.Duration.seconds(5),
                                healthyThresholdCount: 2,
                                unhealthyThresholdCount: 5,
                            },
                        },
                    },
                },
            ],
            // Optional: Start/Stop Scheduler Configuration
            // Example: Start at 08:00 JST and Stop at 18:00 JST on Mon-Fri
            // Timezone set to Asia/Tokyo
            startstopSchedulerConfig: {
                startCronSchedule: 'cron(5 18 ? * MON-FRI *)', // Start at 18:05 JST on Mon-Fri
                stopCronSchedule: 'cron(55 20 ? * MON-FRI *)', // Stop at 20:55 JST on Mon-Fri
                timeZone: cdk.TimeZone.ASIA_TOKYO,
            },
        },
    },
    ecrConfig: {
        "backend": {
            createConfig: {
                repositoryNameSuffix: 'nodejs-backend-repo',
                imageSourcePath: '../../../../backend/example-nodejs-api',
            },
        },
    }

};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;