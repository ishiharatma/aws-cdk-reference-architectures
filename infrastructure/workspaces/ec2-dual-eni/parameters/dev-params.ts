import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  stackNamePrefix: 'ec2-dual-eni',
  tags: {},

  // Set via MANAGEMENT_ALLOWED_CIDRS env var or auto-detected in bin/
  managementAllowedCidrs: [],

  instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
  rootVolumeSize: 8,
};

params[Environment.DEVELOPMENT] = devParams;
