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
  platform: {
    vpcCidr: '10.94.0.0/16',
    natGateways: 1,
    publicGateway: {
      maxAlbCount: 2,
      httpDesync: 'defensive',
      ipAddressType: 'ipv4',
      deletionProtection: false,
      restrictIngressToAllowedIps: true,
      accessLogs: true,
      wafRateLimit: 1000,
    },
    privateGateway: {
      maxAlbCount: 2,
      httpDesync: 'defensive',
      ipAddressType: 'ipv4',
      deletionProtection: false,
    },
    testTrafficHeader: { name: 'x-test-traffic', values: ['canary'] },
  },
  app: {
    containerImage: 'public.ecr.aws/nginx/nginx:stable',
    version: 'v1',
    services: [
      {
        name: 'web',
        accessTypes: ['PUBLIC'],
        desiredCount: 2,
        deploymentStrategy: 'CANARY',
        canary: { stepPercent: 10, bakeMinutes: 5 },
        bakeTimeMinutes: 1,
      },
      { name: 'orders', accessTypes: ['PUBLIC'], desiredCount: 1, deploymentStrategy: 'ROLLING' },
      { name: 'internal-api', accessTypes: ['PRIVATE'], desiredCount: 1, deploymentStrategy: 'ROLLING' },
    ],
  },
};

// Register in the params object
params[Environment.TEST] = testParams;
