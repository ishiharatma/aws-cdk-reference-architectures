import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},
  ec2: {},
  microvm: {
    // AWS-managed al2023 base image (aws lambda-microvms list-managed-microvm-images, ap-northeast-1)
    baseImageArn: 'arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1',
    baseImageVersion: '1',
  },
};

params[Environment.DEVELOPMENT] = devParams;
