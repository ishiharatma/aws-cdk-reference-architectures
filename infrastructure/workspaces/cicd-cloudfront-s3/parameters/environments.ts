import { Environment, EnvironmentConfig  } from "@common/parameters/environments";

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
    readonly repositoryName: string;
    readonly repositoryBranch: string;
    readonly deploymentTargetBucketName: string;
    readonly cloudfrontDistributionId: string;
    /** SNS topic ARN used for the manual approval action and pipeline notifications. Approval stage is skipped when unset. */
    readonly approvalTopicArn?: string;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};