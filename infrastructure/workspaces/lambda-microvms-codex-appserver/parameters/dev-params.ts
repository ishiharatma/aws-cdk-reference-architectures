import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

const devParams: EnvParams = {
  stackNamePrefix: 'lambda-microvms-codex-appserver',
  region: 'ap-northeast-1',
  microvmImage: {
    // Discovered via `aws lambda-microvms list-managed-microvm-images` /
    // `list-managed-microvm-image-versions` against drillexercises-dev,
    // ap-northeast-1 (2026-09-27) -- the AWS-managed al2023 base image.
    baseImageArn: 'arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1',
    baseImageVersion: '1',
  },
  controlPlane: {},
};

params[Environment.DEVELOPMENT] = devParams;
