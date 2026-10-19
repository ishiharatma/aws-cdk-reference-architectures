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
  webFunction: {
    maxConcurrencyPerEnvironment: 64,
    timeoutSeconds: 30,
    maxEnvironments: 3,
    rateLimit: 100,
    enableDebugRoutes: false,
  },
  vpcEgress: { enabled: false, maxAzs: 2 },
  wafRateLimitPerIp: 1000,
};

// Register in the params object
params[Environment.TEST] = testParams;
