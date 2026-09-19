import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Test Environment Parameters
 *
 * Static values only (no env-var / network lookups) so snapshots stay deterministic.
 */
const testParams: EnvParams = {
  region: 'ap-northeast-1',
  tags: {},
  microvmImage: {
    baseImageArn: 'arn:aws:lambda-microvms:ap-northeast-1:123456789012:image/test-base-image',
    baseImageVersion: '1',
  },
  controlPlane: {},
};

// Register in the params object
params[Environment.TEST] = testParams;
