import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  enablePasswordAuthFlow: true, // dev only: lets test-auth.sh sign in without a browser
  callbackUrls: ['http://localhost:3000/callback'],
  logoutUrls: ['http://localhost:3000/'],
  apiRateLimit: 10,
  apiBurstLimit: 20,
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
