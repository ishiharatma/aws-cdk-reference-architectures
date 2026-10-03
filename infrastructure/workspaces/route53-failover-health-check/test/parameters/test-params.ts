import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Test Environment Parameters (static values only so snapshots stay deterministic).
 */
const testParams: EnvParams = {
  region: 'ap-northeast-1',
  tags: {},
  zoneName: 'failover.internal',
  recordName: 'app',
  recordTtl: 10,
  healthCheckIntervalSeconds: 10,
  healthCheckFailureThreshold: 2,
};

params[Environment.TEST] = testParams;
