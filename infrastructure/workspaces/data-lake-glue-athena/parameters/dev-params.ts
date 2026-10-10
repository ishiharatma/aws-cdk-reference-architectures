import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  glueWorkerType: 'G.1X',
  glueNumberOfWorkers: 2,
  glueVersion: '5.0',
  workflowSchedule: undefined,
  athenaBytesScannedCutoff: 100 * 1024 * 1024,
  athenaResultsExpirationDays: 7,
  logRetentionDays: 7,
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
