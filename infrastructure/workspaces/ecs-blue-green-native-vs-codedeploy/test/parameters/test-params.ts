import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Test Environment Parameters (static values only so snapshots stay deterministic)
 */
const testParams: EnvParams = {
  region: 'ap-northeast-1',
  tags: {},

  vpcCidr: '10.92.0.0/16',
  desiredCount: 2,
  containerImage: 'public.ecr.aws/nginx/nginx:stable',
  nativeBakeMinutes: 2,
  codeDeployTerminationWaitMinutes: 2,
  hookDelaySeconds: 25,
};

// Register in the params object
params[Environment.TEST] = testParams;
