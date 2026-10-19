import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  // Lambda Web Functions is available in a subset of Regions (ap-northeast-1 included).
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},
  webFunction: {
    maxConcurrencyPerEnvironment: 64,
    timeoutSeconds: 30,
    maxEnvironments: 3,
    rateLimit: 100,
    enableDebugRoutes: true,
  },
  vpcEgress: { enabled: false, maxAzs: 2 },
  // High enough for the load tests in the README from one allow-listed IP; lower it for real clients.
  wafRateLimitPerIp: 100000,
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
