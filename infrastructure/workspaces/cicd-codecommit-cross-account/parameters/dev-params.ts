import { params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'lib/types';

/**
 * Development environment parameters.
 *
 * The dev account is also where the CodeCommit repository and all three
 * pipelines (dev/stg/prd) are created — see parameters/shared-params.ts.
 */
const devParams: EnvParams = {
  accountId: process.env.DEV_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  branchName: 'develop',
  requireManualApproval: false,
};

params[Environment.DEVELOPMENT] = devParams;
