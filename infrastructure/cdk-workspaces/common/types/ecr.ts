
import * as ecr from "aws-cdk-lib/aws-ecr";

// VPC configuration
export interface EcrConfig {
    /** Existing ECR Repository ARN (if not creating a new one) */
    readonly existingEcrArn?: string;
    /** ECR creation configuration (if creating a new one) */
    readonly createConfig?: EcrCreateConfig;
}

export interface EcrCreateConfig {
    /**
     * ECR Repository name suffix
     */
    readonly repositoryNameSuffix?: string;
    /**
     * ECR Image source path (for initial image push)
     */
    readonly imageSourcePath?: string;
    /**
     * The maximum number of images to retain.
     * @default 30 Count
     */
    readonly maxImageCount?: number;
    /**
     * The maximum age of images to retain. The value must represent a number of days.
     * @default 90 Days
     */
    readonly untaggedDurationDays?: number;
    /**
     * The maximum age of images to retain. The value must represent a number of days.
     * @default 180 Days
     */
    readonly anytagDurationDays?: number;

    /**
     * image tag mutability setting for the repository.
     * @default ecr.TagMutability.MUTABLE
     */
    readonly imageTagMutability?: ecr.TagMutability;

    /**
     * Whether to enable image scan on push.
     * @default false
     */
    readonly isImageScanOnPush?: boolean;
}