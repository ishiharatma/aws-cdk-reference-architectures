import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

const testParams: EnvParams = {
  region: 'ap-northeast-1',
  stackNamePrefix: 'ec2-dual-eni',
  tags: {},
  managementAllowedCidrs: ['203.0.113.0/24'],
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
  rootVolumeSize: 8,
};

params[Environment.TEST] = testParams;
