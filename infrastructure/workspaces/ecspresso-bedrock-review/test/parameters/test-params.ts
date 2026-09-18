import { EnvParams, SharedParams } from 'lib/types';

export const testSharedParams: SharedParams = {
  repositoryName: 'ecspresso-bedrock-review-app',
};

export const testEnvParams: EnvParams = {
  accountId: '111111111111',
  region: 'ap-northeast-1',
  tags: {},
  branchName: 'develop',
  requireManualApproval: false,
  bedrockModelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  riskThreshold: 'high',
  reviewLanguage: 'en',
  ecsTaskCpu: 256,
  ecsTaskMemory: 512,
  ecsDesiredCount: 1,
  enableEcsExec: false,
  autoScalingEnabled: false,
};

export const testEnvParamsWithApproval: EnvParams = {
  ...testEnvParams,
  requireManualApproval: true,
};

export const testEnvParamsWithAutoScaling: EnvParams = {
  ...testEnvParams,
  autoScalingEnabled: true,
};

export const testEnvParamsWithJapaneseReview: EnvParams = {
  ...testEnvParams,
  reviewLanguage: 'ja',
};

export const testEnvParamsWithReviewNotification: EnvParams = {
  ...testEnvParams,
  reviewNotificationEnabled: true,
};

export const testEnvParamsWithApprovalTopicAndNotification: EnvParams = {
  ...testEnvParams,
  requireManualApproval: true,
  approvalTopicArn: 'arn:aws:sns:ap-northeast-1:111111111111:custom-approval-topic',
  reviewNotificationEnabled: true,
};
