import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Test Environment Parameters (static values only so snapshots stay deterministic).
 */
const testParams: EnvParams = {
  region: 'ap-northeast-1',
  tags: {},
  primaryRegion: 'ap-northeast-1',
  drRegion: 'ap-northeast-3',
  vpcCidr: '10.40.0.0/24',
  recordTtl: 10,
  healthCheckIntervalSeconds: 10,
  healthCheckFailureThreshold: 2,
  warmStandbyConcurrency: 0,
  backupScheduleCron: 'cron(0 18 * * ? *)',
  backupRetentionDays: 1,
};

params[Environment.TEST] = testParams;
