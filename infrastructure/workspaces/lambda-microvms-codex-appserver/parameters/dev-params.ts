import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

const devParams: EnvParams = {
  stackNamePrefix: 'lambda-microvms-codex-appserver',
  region: 'ap-northeast-1',
  microvmImage: {
    // Placeholder values. Replace with a real base image ARN/version for
    // your account and Region before deploying -- discover candidates with:
    //   aws lambda-microvms list-managed-microvm-images
    baseImageArn: 'arn:aws:lambda-microvms:ap-northeast-1:REPLACE_WITH_ACCOUNT_ID:image/REPLACE_ME',
    baseImageVersion: 'REPLACE_ME',
  },
  controlPlane: {},
};

params[Environment.DEVELOPMENT] = devParams;
