import { params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';
import { EnvParams, SharedParams } from 'lib/types';

const testParams: EnvParams = {
  accountId: '111111111111',
  region: 'ap-northeast-1',
  tags: {},
  branchName: 'develop',
  requireManualApproval: false,
};

params[Environment.TEST] = testParams;

export const testEnvParamsMap: Partial<Record<Environment, EnvParams>> = {
  [Environment.DEVELOPMENT]: {
    accountId: '111111111111',
    region: 'ap-northeast-1',
    tags: {},
    branchName: 'develop',
  },
  [Environment.STAGING]: {
    accountId: '222222222222',
    region: 'ap-northeast-1',
    tags: {},
    branchName: 'staging',
  },
  [Environment.PRODUCTION]: {
    accountId: '333333333333',
    region: 'ap-northeast-1',
    tags: {},
    branchName: 'main',
    requireManualApproval: false,
  },
};

export const testSharedParams: SharedParams = {
  repositoryName: 'sample-app',
  codecommitAccountId: '111111111111',
};
