import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
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
      // Two public services share one ALB through host-based routing.
      {
        name: 'web',
        accessTypes: ['PUBLIC'],
        desiredCount: 2,
        deploymentStrategy: 'CANARY',
        canary: { stepPercent: 10, bakeMinutes: 5 },
        bakeTimeMinutes: 1,
      },
      { name: 'orders', accessTypes: ['PUBLIC'], desiredCount: 1, deploymentStrategy: 'ROLLING' },
      // Internal-only: without the PRIVATE filter it would also connect to the public gateway.
      { name: 'internal-api', accessTypes: ['PRIVATE'], desiredCount: 1, deploymentStrategy: 'ROLLING' },
    ],
  },
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
