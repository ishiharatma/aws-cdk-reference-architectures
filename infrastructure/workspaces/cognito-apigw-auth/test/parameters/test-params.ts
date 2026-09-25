import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Test Environment Parameters (static values only so snapshots stay deterministic).
 */
const testParams: EnvParams = {
  region: 'ap-northeast-1',
  tags: {},
  enablePasswordAuthFlow: true,
  callbackUrls: ['http://localhost:3000/callback'],
  logoutUrls: ['http://localhost:3000/'],
  apiRateLimit: 10,
  apiBurstLimit: 20,
};

params[Environment.TEST] = testParams;
