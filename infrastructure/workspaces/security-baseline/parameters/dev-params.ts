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
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
