import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { params, EnvParams } from 'parameters/environments';
import { NatType } from '@common/types';
import { Environment } from '@common/parameters/environments';

const testParams: EnvParams = {
  accountId: '123456789012',
  region: 'ap-northeast-1',
  stackNamePrefix: 'ec2-advanced',
  tags: {},
  vpcConfig: {
    createConfig: {
      vpcName: 'TestVpc',
      cidr: '10.0.0.0/16',
      maxAzs: 2,
      natCount: 1,
      natType: NatType.INSTANCE,
      subnets: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    },
  },
  ec2Config: {
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
    rootVolumeSize: 8,
  },
  ports: [80],
};

params[Environment.TEST] = testParams;
