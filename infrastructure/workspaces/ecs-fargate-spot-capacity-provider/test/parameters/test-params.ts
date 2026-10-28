import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Test Environment Parameters
 *
 * Static values only (no env-var / network lookups) so snapshots stay deterministic.
 */
const testParams: EnvParams = {
  region: 'ap-northeast-1',
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
params[Environment.TEST] = testParams;
