import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 *
 * VPC layout: two Availability Zones, isolated subnets only (/24). No NAT gateway: the probe reaches Secrets Manager
 * through an interface endpoint, and the databases need no internet access.
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  vpcConfig: {
    createConfig: {
      vpcName: 'rds-compare-vpc',
      cidr: '10.91.0.0/16',
      maxAzs: 2,
      natCount: 0,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24, name: 'Isolated' }],
      interfaceEndpoints: [
        { service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER, subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED } },
      ],
    },
  },

  dbInstanceClass: 'db.t4g.micro',
  allocatedStorage: 20,
  replicaLagAlarmSeconds: 120,
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
