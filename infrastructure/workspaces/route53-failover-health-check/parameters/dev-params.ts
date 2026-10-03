import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  zoneName: 'failover.internal',
  recordName: 'app',
  recordTtl: 10,
  healthCheckIntervalSeconds: 10,
  healthCheckFailureThreshold: 2,
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
