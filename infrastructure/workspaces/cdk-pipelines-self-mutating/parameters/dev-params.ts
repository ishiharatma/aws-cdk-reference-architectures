import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  // Account ID (checked against the credentials in use when set)
  //accountId: process.env.CDK_DEFAULT_ACCOUNT || '111111111111',

  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
