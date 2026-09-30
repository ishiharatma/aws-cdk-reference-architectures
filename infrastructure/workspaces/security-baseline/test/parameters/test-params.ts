import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Test Environment Parameters (static values only so snapshots stay deterministic).
 */
const testParams: EnvParams = {
  region: 'ap-northeast-1',
  tags: {},

  logArchiveExpirationDays: 365,
  trailLogGroupRetentionDays: 90,
  guardDuty: {
    s3Protection: true,
    ebsMalwareProtection: true,
    rdsLoginEvents: true,
    lambdaNetworkLogs: true,
  },
  additionalSecurityHubStandardArns: [],
  enableUnusedAccessAnalyzer: true,
  unusedAccessAgeDays: 90,
};

params[Environment.TEST] = testParams;
