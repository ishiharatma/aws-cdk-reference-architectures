import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Test Environment Parameters (static values only so snapshots stay deterministic).
 */
const testParams: EnvParams = {
  region: 'ap-northeast-1',
  tags: {},
  minCapacity: 0.5,
  maxCapacity: 2,
  rotationDays: 30,
  appUsername: 'appuser',
  databaseName: 'appdb',
};

params[Environment.TEST] = testParams;
