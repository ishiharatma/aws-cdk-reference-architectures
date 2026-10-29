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
    vpcCidr: '10.96.0.0/16',
    maxAzs: 3,
    natGateways: 1,
  },
  kubernetesVersion: '1.36',
  managedNodeGroup: {
    enabled: true,
    nodeGroup: {
      instanceTypes: ['t3.medium'],
      minSize: 2,
      desiredSize: 2,
      maxSize: 4,
      diskSizeGiB: 20,
    },
    albControllerChartVersion: '3.2.2',
  },
  autoMode: {
    enabled: true,
    nodePools: ['system', 'general-purpose'],
  },
  webApp: {
    image: 'public.ecr.aws/docker/library/python:3.13-alpine',
    replicas: 3,
    cpuRequest: '100m',
    memoryRequest: '64Mi',
    memoryLimit: '128Mi',
    drainSeconds: 10,
    terminationGracePeriodSeconds: 30,
    deregistrationDelaySeconds: 15,
  },
  logRetentionDays: 7,
};

// Register in the params object
params[Environment.TEST] = testParams;
