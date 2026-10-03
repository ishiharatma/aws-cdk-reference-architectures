import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Test Environment Parameters (static values only so snapshots stay deterministic).
 */
const testParams: EnvParams = {
  region: 'ap-northeast-1',
  tags: {},
  vpcCidr: '10.20.0.0/16',
  natGateways: 1,
  desiredCount: 2,
  apiRateLimit: 5,
  apiBurstLimit: 10,
  apiDailyQuota: 1000,
};

params[Environment.TEST] = testParams;
