import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},
  microvm: {
    // AWS-managed al2023 base image (aws lambda-microvms list-managed-microvm-images, ap-northeast-1)
    baseImageArn: 'arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1',
    baseImageVersion: '1',
  },
  // A NAT instance keeps a verification environment cheap; use 'gateway' for anything shared.
  ec2: { natType: 'instance' },
  controlPlane: {},
  codeCommit: {
    // Created for verification and deleted with the stacks. List existing repositories in repositoryNames.
    managedRepositoryNames: ['code-server-sessions-demo'],
  },
};

params[Environment.DEVELOPMENT] = devParams;
