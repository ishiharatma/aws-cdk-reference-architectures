import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  vpcCidr: '10.92.0.0/16',
  desiredCount: 2,
  containerImage: 'public.ecr.aws/nginx/nginx:stable',
  nativeBakeMinutes: 2,
  codeDeployTerminationWaitMinutes: 2,
  hookDelaySeconds: 25,
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
