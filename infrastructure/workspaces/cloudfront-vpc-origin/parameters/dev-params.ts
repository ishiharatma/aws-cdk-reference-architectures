import { params, EnvParams } from 'parameters/environments';
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

    // Common tags
    tags: {},
    // VCP Configuration
    vpcConfig: {
        //existingVpcId: undefined, // Set VPC ID if using existing VPC
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
    cloudfrontManagedPrefixList: 'pl-58a04531',

    // Incident-response escape hatch — keep disabled by default. Flip `enabled: true` and
    // redeploy to switch CloudFront's `/alb/*` behavior from the VPC Origin to a plain public
    // HTTP origin during an incident where VPC Origin connectivity itself is degraded, e.g. the
    // 2026-07-16 AWS CloudFront VPC Origins outage. Traffic still flows only through CloudFront.
    // Revert to `false` and redeploy once AWS resolves the underlying issue.
    publicAlbFailover: {
        enabled: false,
    },

    // Set this to receive the CloudFront 5xx error rate alarm by email (see CloudfrontMonitoringStack).
    // alarmEmail: 'ops-team@example.com',
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;