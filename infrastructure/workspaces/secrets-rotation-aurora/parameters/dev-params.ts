import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  minCapacity: 0.5,
  maxCapacity: 2,
  rotationDays: 30,
  appUsername: 'appuser',
  databaseName: 'appdb',
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
