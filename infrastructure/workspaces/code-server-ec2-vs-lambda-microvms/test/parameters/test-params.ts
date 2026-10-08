import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/** Static values only so snapshots stay deterministic. */
const testParams: EnvParams = {
  region: 'ap-northeast-1',
  tags: {},
  ec2: {},
  microvm: {
    baseImageArn: 'arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1',
    baseImageVersion: '1',
  },
};

params[Environment.TEST] = testParams;
