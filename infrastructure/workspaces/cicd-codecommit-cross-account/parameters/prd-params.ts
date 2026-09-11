import { params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'lib/types';

/**
 * Production environment parameters.
 *
 * The prd pipeline (defined in the dev account's PipelineStack) deploys
 * cross-account into this account by assuming the role created here by
 * CrossAccountDeployRoleStack.
 *
 * Set `requireManualApproval: true` and `approvalTopicArn` to gate the
 * Deploy stage behind a manual approval + SNS notification.
 */
const prdParams: EnvParams = {
  accountId: process.env.PRD_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  branchName: 'main',
  requireManualApproval: false,
  // approvalTopicArn: 'arn:aws:sns:ap-northeast-1:999988887777:cicd-x-account-prd-approvals',
};

params[Environment.PRODUCTION] = prdParams;
