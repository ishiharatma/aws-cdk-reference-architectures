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

  /** Fargate task vCPU units (ecspresso task definition). @default 256 */
  readonly ecsTaskCpu?: number;
  /** Fargate task memory (MiB) (ecspresso task definition). @default 512 */
  readonly ecsTaskMemory?: number;
  /** Desired task count (ecspresso service definition). @default 1 */
  readonly ecsDesiredCount?: number;
  /** Enable ECS Exec on the service. @default false */
  readonly enableEcsExec?: boolean;

  /**
   * Actually call Security Hub BatchImportFindings with the Trivy scan
   * results (converted to ASFF by scripts/sechub_parser.py). When false,
   * the Build stage still runs the conversion but only logs the ASFF
   * findings — nothing is sent to Security Hub.
   * @default false
   */
  readonly securityHubImportEnabled?: boolean;
}
