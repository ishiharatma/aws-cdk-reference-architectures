import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';

/**
 * ECS Fargate Construct Properties
 */
export interface InfraCIConstructProps {
    readonly project: string;
    readonly environment: string;
    readonly repositoryName: string;
    readonly branchName: string;
    readonly snsTopic?: sns.ITopic;
}

export class InfraCIConstruct extends Construct {
    public readonly cluster: ecs.ICluster;
    public readonly services: ecs.IFargateService[] = [];
    //private readonly serviceDesiredCounts: Map<ecs.IFargateService, number> = new Map<ecs.IFargateService, number>();

    constructor(scope: Construct, id: string, props: InfraCIConstructProps) {
        super(scope, id);

        // log Group
        const buildlog = new logs.LogGroup(this, 'InfraCILogGroup', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            retention: 30
        });

        // Create Build Project
        const buildProjecy = new codebuild.PipelineProject(this, 'InfraCIBuildProject', {
            projectName: `${props.project}-${props.environment}-infracibuild`,
            logging: {
                cloudWatch: {
                    logGroup: buildlog,
                    logStreamName: 'InfraCIBuildLogStream',
                },
            },
            environment: {
                buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
                privileged: true, // Required for Docker builds
            },
            buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec-infra-ci.yml'),
        });

        // Create CodeCommit Repository
        const repository = codecommit.Repository.fromRepositoryName(
            this,
            'InfraCIRepository',
            props.repositoryName,
        );

        // Create CodePipeline
        const sourceOutput = new codepipeline.Artifact();
        const pipeline = new codepipeline.Pipeline(this, 'InfraCIPipeline', {
            pipelineName: `${props.project}-${props.environment}-infraci-pipeline`,
        });

        // add Source Stage
        pipeline.addStage({
            stageName: 'Source',
            actions: [
                new codepipeline_actions.CodeCommitSourceAction({
                    actionName: 'CodeCommit_Source',
                    repository,
                    branch: props.branchName,
                    output: sourceOutput,
                }),
            ],
        });

        // CDK Test Stage
        pipeline.addStage({
            stageName: 'CDK_Test',
            actions: [
                new codepipeline_actions.CodeBuildAction({
                    actionName: 'CDK_Test_Build',
                    project: buildProjecy,
                    input: sourceOutput,
                    environmentVariables: {
                        'TEST_TYPE': { value: 'cdk' },
                    },
                }),
            ],
        });

        // Notifier
        if (props.snsTopic) {
            
        }
    }
}