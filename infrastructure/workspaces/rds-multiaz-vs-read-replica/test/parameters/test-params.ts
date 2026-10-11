import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Test Environment Parameters (static values only so snapshots stay deterministic).
 */
const testParams: EnvParams = {
  region: 'ap-northeast-1',
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

params[Environment.TEST] = testParams;
