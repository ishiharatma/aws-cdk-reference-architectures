import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Test Environment Parameters (static values only so snapshots stay deterministic).
 */
const testParams: EnvParams = {
  region: 'ap-northeast-1',
  tags: {},
  highValueThreshold: 1000,
  archiveRetentionDays: 1,
  targetMaxEventAgeMinutes: 60,
  targetRetryAttempts: 3,
};

params[Environment.TEST] = testParams;
