import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
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
  enableUnusedAccessAnalyzer: false,
  unusedAccessAgeDays: 90,
  notification: {
    severities: ['CRITICAL', 'HIGH'],
    // Add addresses here; each recipient must confirm the subscription email.
    emails: [],
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

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
