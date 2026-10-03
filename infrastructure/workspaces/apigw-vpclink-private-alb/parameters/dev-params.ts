import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  vpcCidr: '10.20.0.0/16',
  natGateways: 1,
  desiredCount: 2,
  apiRateLimit: 5,
  apiBurstLimit: 10,
  apiDailyQuota: 1000,
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
