import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  network: {
    vpcCidr: '10.95.0.0/16',
    maxAzs: 3,
    natGateways: 1,
  },

  containerImage: 'public.ecr.aws/docker/library/python:3.13-alpine',

  service: {
    desiredCount: 6,
    cpu: 256,
    memoryLimitMiB: 512,
    // 2 tasks always on FARGATE; the rest split 1:3, so 6 tasks become 3 FARGATE + 3 FARGATE_SPOT.
    capacityProviderStrategies: [
      { capacityProvider: 'FARGATE', base: 2, weight: 1 },
      { capacityProvider: 'FARGATE_SPOT', weight: 3 },
    ],
    availabilityZoneRebalancing: 'ENABLED',
    minHealthyPercent: 100,
    maxHealthyPercent: 200,
    stopTimeoutSeconds: 120,
    drainSeconds: 15,
    deregistrationDelaySeconds: 30,
    autoScaling: {
      minCapacity: 6,
      maxCapacity: 12,
      targetCpuUtilizationPercent: 60,
    },
  },

  logRetentionDays: 7,
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
