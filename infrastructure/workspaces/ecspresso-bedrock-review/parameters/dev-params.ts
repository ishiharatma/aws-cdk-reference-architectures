import { params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';
import { EnvParams, ReviewLanguage } from 'lib/types';

/**
 * Development environment parameters.
 */
const devParams: EnvParams = {
  accountId: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  branchName: 'develop',
  requireManualApproval: false,

  // Just edit this to switch Bedrock models (no code change needed).
  // Passed through as the CodeBuild BEDROCK_MODEL_ID environment variable.
  bedrockModelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  riskThreshold: 'high',
  // Language the review summary/findings are written in: 'en' | 'ja'. Default 'en'.
  reviewLanguage: (process.env.REVIEW_LANGUAGE as ReviewLanguage) || 'en',

  ecsTaskCpu: 256,
  ecsTaskMemory: 512,
  // Fixed at 1 for this sample. If the target service has Application Auto
  // Scaling configured, set autoScalingEnabled: true instead (this
  // ecsDesiredCount is then ignored, and deploy stops overwriting whatever
  // value Auto Scaling has set -- see the autoScalingEnabled comment in
  // lib/types/index.ts for details).
  ecsDesiredCount: 1,
  enableEcsExec: false,
  autoScalingEnabled: false,

  // Whether to actually send Trivy scan results (converted to ASFF) to
  // Security Hub. false (default) only logs them; nothing is sent.
  securityHubImportEnabled: process.env.SECURITYHUB_IMPORT_ENABLED === 'true',

  // Publish the agentic review's summary to SNS when the AgenticReview stage
  // completes, so it reaches a human before the Approve stage. false
  // (default): the summary is only in the CodeBuild logs and the
  // AgenticReviewOutput artifact.
  reviewNotificationEnabled: process.env.REVIEW_NOTIFICATION_ENABLED === 'true',
};

params[Environment.DEVELOPMENT] = devParams;
