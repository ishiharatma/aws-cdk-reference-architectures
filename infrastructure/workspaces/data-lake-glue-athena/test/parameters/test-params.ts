import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Test Environment Parameters (static values only so snapshots stay deterministic).
 */
const testParams: EnvParams = {
  region: 'ap-northeast-1',
  tags: {},
  glueWorkerType: 'G.1X',
  glueNumberOfWorkers: 2,
  glueVersion: '5.0',
  workflowSchedule: undefined,
  athenaBytesScannedCutoff: 100 * 1024 * 1024,
  athenaResultsExpirationDays: 7,
  logRetentionDays: 7,
};

params[Environment.TEST] = testParams;
