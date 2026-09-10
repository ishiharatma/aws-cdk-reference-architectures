import { params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'lib/types';

/**
 * Staging environment parameters.
 *
 * The stg pipeline (defined in the dev account's PipelineStack) deploys
 * cross-account into this account by assuming the role created here by
 * CrossAccountDeployRoleStack.
 */
const stgParams: EnvParams = {
  accountId: process.env.STG_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  branchName: 'staging',
  requireManualApproval: false,
};

params[Environment.STAGING] = stgParams;
