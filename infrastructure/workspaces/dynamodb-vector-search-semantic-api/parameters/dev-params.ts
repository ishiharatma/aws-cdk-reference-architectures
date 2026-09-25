import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  // Account ID
  //accountId: process.env.CDK_DEFAULT_ACCOUNT || '111111111111', // if you want to specify

  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  embeddingModelId: 'amazon.titan-embed-text-v2:0',
  embeddingDimensions: 256,
  apiRateLimit: 5,
  apiBurstLimit: 10,
  apiDailyQuota: 1000,
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
