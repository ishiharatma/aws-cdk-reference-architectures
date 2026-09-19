import { EnvironmentConfig } from '@common/parameters/environments';

/**
 * Parameters shared by every environment.
 */
export interface SharedParams {
  /** Name of the CodeCommit repository (seeded from backend/ecspresso-bedrock-review-app) */
  readonly repositoryName: string;
}

/** Bedrock agentic review overall risk levels, ordered from lowest to highest. */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Language the agentic review's summary/findings are written in. */
export type ReviewLanguage = 'en' | 'ja';

/**
 * Per-environment parameters.
 */
export interface EnvParams extends EnvironmentConfig {
  /** CodeCommit branch that triggers this environment's pipeline */
  readonly branchName: string;
  /**
   * Insert a manual approval stage before Deploy.
   * @default false
   */
  readonly requireManualApproval?: boolean;
  /** SNS topic ARN for manual approval notifications. Used only when requireManualApproval is true. */
  readonly approvalTopicArn?: string;

  /**
   * Bedrock model ID (or cross-region inference profile ID) used by the
   * agentic review stage. Passed through unchanged as the CodeBuild
   * `BEDROCK_MODEL_ID` env var — swapping the review model never requires a
   * code change.
   */
  readonly bedrockModelId: string;
  /**
   * Minimum overall risk level (low/medium/high/critical) that blocks the
   * pipeline (CodeBuild exits non-zero).
   * @default 'high'
   */
  readonly riskThreshold?: RiskLevel;
  /**
   * Language the model writes its review summary/findings in. Passed
   * through unchanged as the CodeBuild `REVIEW_LANGUAGE` env var.
   * @default 'en'
   */
  readonly reviewLanguage?: ReviewLanguage;

  /** Fargate task vCPU units (ecspresso task definition). @default 256 */
  readonly ecsTaskCpu?: number;
  /** Fargate task memory (MiB) (ecspresso task definition). @default 512 */
  readonly ecsTaskMemory?: number;
  /** Desired task count (ecspresso service definition). @default 1 */
  readonly ecsDesiredCount?: number;
  /** Enable ECS Exec on the service. @default false */
  readonly enableEcsExec?: boolean;
  /**
   * Set this to true when the target ECS service has Application Auto
   * Scaling configured. It makes ecs-service-def.jsonnet omit the
   * `desiredCount` field entirely, so `ecspresso deploy` does not pass a
   * DesiredCount to UpdateService — leaving whatever count Auto Scaling has
   * set untouched. If left false, `ecsDesiredCount` is written into the
   * service definition on every deploy and will stomp on Auto Scaling's
   * current desired count.
   * @default false
   */
  readonly autoScalingEnabled?: boolean;

  /**
   * Actually call Security Hub BatchImportFindings with the Trivy scan
   * results (converted to ASFF by scripts/sechub_parser.py). When false,
   * the Build stage still runs the conversion but only logs the ASFF
   * findings — nothing is sent to Security Hub.
   * @default false
   */
  readonly securityHubImportEnabled?: boolean;

  /**
   * Publish the agentic review's summary to the pipeline's SNS
   * notification topic when the AgenticReview stage completes. This is the
   * only way to put the review result in front of a human before the
   * Approve stage, since ManualApprovalAction's `additionalInformation` is
   * a static string baked into the CloudFormation template and can't carry
   * a per-run value. When false (default), the summary is only available
   * in the AgenticReview CodeBuild logs and the AgenticReviewOutput
   * artifact.
   * @default false
   */
  readonly reviewNotificationEnabled?: boolean;
}
