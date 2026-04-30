import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecrdeploy from 'cdk-ecr-deployment'
import { Construct } from 'constructs';
import { existsSync } from 'fs';
import { Environment } from "../parameters/environments";
import { EcrConfig } from '../types/ecr';
import { C_RESOURCE } from '../constants';

interface EcrProps {
    readonly project: string;
    readonly environment: Environment;
    readonly ecrConfig?: EcrConfig;
    readonly removalPolicy?: cdk.RemovalPolicy;
    readonly isImageSourceBuild?: boolean;
    readonly imageTag?: string;
}

export class EcrConstruct extends Construct {
    public readonly ecr: ecr.IRepository;
    public readonly imageTag?: string;

    constructor(scope: Construct, id: string, props: EcrProps) {
        super(scope, id);

        const maxImageCount:number = props.ecrConfig?.createConfig?.maxImageCount ?? 30
        const untaggedImageAge: number = props.ecrConfig?.createConfig?.untaggedDurationDays ?? 90;
        const anytagImageAge: number = props.ecrConfig?.createConfig?.anytagDurationDays ?? 180;

        let repository: ecr.IRepository;

        if (props.ecrConfig?.createConfig && !props.ecrConfig?.existingEcrArn) {
            // If we want to create a new ECR repo, existingEcrArn must not be specified
            if (props.ecrConfig?.existingEcrArn) {
                throw new Error('existingEcrArn should not be specified when createConfig is provided');
            }

            if (maxImageCount > 100) {
                throw new Error('maxImageCount cannot be greater than 100');
            }

            // Create the ECR Repository
            repository = new ecr.Repository(this, C_RESOURCE, {
                repositoryName: props.ecrConfig?.createConfig?.repositoryNameSuffix ? 
                `${props.project}-${props.environment}-${props.ecrConfig.createConfig.repositoryNameSuffix}` : undefined,
                removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY, // NOT recommended for production environments
                emptyOnDelete: true, // Recommended for production environments
                encryption: ecr.RepositoryEncryption.AES_256,
                imageScanOnPush: props.ecrConfig?.createConfig?.isImageScanOnPush ?? undefined, // Use default false
                imageTagMutability: props.ecrConfig?.createConfig?.imageTagMutability ?? undefined, // Use default mutable setting
                lifecycleRules: [
                    // Keep latest images with environment tag
                    {
                        rulePriority: 10,
                        description: 'Keep latest 5 images with "latest" tag',
                        maxImageCount: 5,
                        tagPatternList: ["latest"],
                        tagStatus: ecr.TagStatus.TAGGED,
                    },
                    // Only keep maxImageCount images with environment tag
                    {
                        rulePriority: 20,
                        description: `Limit the number of images to ${maxImageCount}`,
                        maxImageCount: maxImageCount,
                        tagPatternList: [props.environment],
                        tagStatus: ecr.TagStatus.TAGGED,
                    },
                    // rule for untagged images
                    {
                        rulePriority: 990,
                        description: `Expire untagged images older than ${untaggedImageAge} days`,
                        maxImageAge: cdk.Duration.days(untaggedImageAge),
                        tagStatus: ecr.TagStatus.UNTAGGED,
                    },
                    // rule for any tagged images
                    {
                        rulePriority: 999,
                        description: `Expire any tagged images older than ${anytagImageAge} days`,
                        maxImageAge: cdk.Duration.days(anytagImageAge),
                        tagStatus: ecr.TagStatus.ANY,
                    },
                ],
            });
            this.ecr = repository;
        } else if (props.ecrConfig?.existingEcrArn && !props.ecrConfig?.createConfig) {
            // If we want to use an existing ECR repo, createConfig must not be specified
            repository = ecr.Repository.fromRepositoryArn(this, C_RESOURCE, props.ecrConfig.existingEcrArn);
            this.ecr = repository;
        } else {
            throw new Error('Either createConfig or existingEcrArn must be specified');
        }

        new cdk.CfnOutput(this, 'RepositoryUri', {
            value: repository.repositoryUri,
            exportName: `${props.project}-${props.environment}-ecr-repo-uri`,
        });
        new cdk.CfnOutput(this, 'RepositoryName', {
            value: repository.repositoryName,
            exportName: `${props.project}-${props.environment}-ecr-repo-name`,
        });

        if (props.ecrConfig?.createConfig?.imageSourcePath && props.isImageSourceBuild) {
            // Validate image source path exists
            if (!existsSync(props.ecrConfig.createConfig.imageSourcePath)) {
                throw new Error(
                    `Image source path does not exist: ${props.ecrConfig.createConfig.imageSourcePath}\n` +
                    `Make sure the Docker context path is correct.`
                );
            }
            console.log(`📦 Building Docker image from: ${props.ecrConfig.createConfig.imageSourcePath}`);
            const imageTag = props.imageTag || 'latest';
            this.imageTag = imageTag;
            const dockerImageAsset = new ecr_assets.DockerImageAsset(this, "DockerImageAsset", {
                directory: props.ecrConfig.createConfig.imageSourcePath,
                platform: ecr_assets.Platform.LINUX_AMD64,
            });
            console.log(`⬆️  Pushing image to ECR: ${repository.repositoryUriForTag(this.imageTag)}`);
            
            new ecrdeploy.ECRDeployment(this, 'EcrImageAsset', {
                src: new ecrdeploy.DockerImageName(dockerImageAsset.imageUri),
                dest: new ecrdeploy.DockerImageName(repository.repositoryUriForTag(this.imageTag)),
            });
        } else if (props.isImageSourceBuild) {
            // Warn if bootstrap flag is set but no image source path
            console.warn(
                '⚠️  Warning: CDK_ECR_BOOTSTRAP is set but imageSourcePath is not configured.\n' +
                '   No Docker image will be built. Make sure to push an image before deploying ECS.'
            );
        }

    }
}