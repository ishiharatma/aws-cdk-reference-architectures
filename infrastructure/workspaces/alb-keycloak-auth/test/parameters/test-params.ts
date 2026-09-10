import * as cdk from 'aws-cdk-lib';
import { params, EnvParams } from 'parameters/environments';
import { NatType } from '@common/types';
import { Environment } from '@common/parameters/environments';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

const testParams: EnvParams = {
  region: 'ap-northeast-1',
  stackNamePrefix: 'alb-keycloak-auth',
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
  auroraConfig: {
    databaseName: 'keycloakdb',
    masterUsername: 'keycloak',
    serverlessV2MinCapacity: 0.5,
    serverlessV2MaxCapacity: 4,
  },
  keycloakConfig: {
    keycloakVersion: '26.1',
    realmName: 'testrealm',
    cpu: 1024,
    memoryLimitMiB: 2048,
    desiredCount: 1,
  },
  oidcConfig: {
    enabled: false,
    clientId: 'alb-client',
  },
};

params[Environment.TEST] = testParams;
