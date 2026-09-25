import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  highValueThreshold: 1000,
  archiveRetentionDays: 1,
  targetMaxEventAgeMinutes: 60,
  targetRetryAttempts: 3,
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
