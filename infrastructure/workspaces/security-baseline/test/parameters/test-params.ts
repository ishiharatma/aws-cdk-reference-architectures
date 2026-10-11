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
  notification: {
    severities: ['CRITICAL', 'HIGH'],
    emails: ['security@example.com'],
  },
  remediation: {
    mode: 'dry-run',
    s3ControlIds: ['S3.8', 'S3.2', 'S3.3'],
    sgControlIds: ['EC2.13', 'EC2.14', 'EC2.53', 'EC2.54'],
    remoteAdminPorts: [22, 3389],
    guardDutyMinSeverity: 'HIGH',
    skipTagKey: 'security-baseline:remediation-skip',
    acceptImportedFindings: true,
  },
};

params[Environment.TEST] = testParams;
