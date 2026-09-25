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
  embeddingModelId: 'amazon.titan-embed-text-v2:0',
  embeddingDimensions: 256,
  apiRateLimit: 5,
  apiBurstLimit: 10,
  apiDailyQuota: 1000,
};

// Register in the params object
params[Environment.TEST] = testParams;
