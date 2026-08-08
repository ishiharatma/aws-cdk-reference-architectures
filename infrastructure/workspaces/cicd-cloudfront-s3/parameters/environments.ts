import { Environment, EnvironmentConfig  } from "@common/parameters/environments";

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
    readonly repositoryName: string;
    readonly repositoryBranch: string;
    /**
     * Whether to enable the build stage in the pipeline. If false, the build stage will be skipped and the source code will be deployed directly to the target S3 bucket.
     * @default false
     */
    readonly enableBuild?: boolean;
    readonly deploymentTargetBucketName: string;
    readonly cloudfrontDistributionId: string;
    /** SNS topic ARN used for the manual approval action and pipeline notifications. Approval stage is skipped when unset. */
    readonly approvalTopicArn?: string;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};