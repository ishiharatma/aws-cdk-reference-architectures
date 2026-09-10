import { EnvironmentConfig } from '@common/parameters/environments';

/**
 * Parameters shared by every environment.
 * The CodeCommit repository account ID is intentionally NOT hard-coded here even
 * though it conceptually belongs here — this is a public repository, so the value
 * is injected via the `CODECOMMIT_ACCOUNT_ID` environment variable instead
 * (see parameters/shared-params.ts).
 */
export interface SharedParams {
  /** Name of the CodeCommit repository created in the dev account */
  readonly repositoryName: string;
  /**
   * AWS account ID that owns the CodeCommit repository (the dev account).
   * Read from the `CODECOMMIT_ACCOUNT_ID` environment variable at synth time.
   */
  readonly codecommitAccountId?: string;
}

/**
 * Per-environment parameters.
 */
export interface EnvParams extends EnvironmentConfig {
  /** CodeCommit branch that triggers this environment's pipeline (develop/staging/main) */
  readonly branchName: string;
  /**
   * Insert a manual approval stage before Deploy.
   * @default false
   */
  readonly requireManualApproval?: boolean;
  /** SNS topic ARN for manual approval notifications. Required when requireManualApproval is true. */
  readonly approvalTopicArn?: string;
}
