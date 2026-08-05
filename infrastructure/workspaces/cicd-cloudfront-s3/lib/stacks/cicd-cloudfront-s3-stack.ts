import * as cdk from 'aws-cdk-lib';
import { StackProps } from 'aws-cdk-lib';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_action from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codestar_notification from 'aws-cdk-lib/aws-codestarnotifications';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as path from 'path';

interface CicdCloudfrontS3StackProps extends StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly envParams: EnvParams;
}

export class CicdCloudfrontS3Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CicdCloudfrontS3StackProps) {
    super(scope, id, props);

    const s3SyncLambdaPath = path.join(__dirname, '../../../../common/src/python-lambda/codedeploy-s3-sync');
    const cloudfrontInvalidationLambdaPath = path.join(__dirname, '../../../../common/src/python-lambda/cloudfront-create-invalidation');
    const InvalidationCompleteSnsTopic = new sns.Topic(this, 'InvalidationCompleteSnsTopic', {
      enforceSSL: true,
    });

    const s3SyncLambda = new lambda.Function(this, 'S3SyncLambda', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(s3SyncLambdaPath),
      environment: {
        DEST_BUCKET_NAME: props.envParams.deploymentTargetBucketName,
      },
      logGroup: new logs.LogGroup(this, 'S3SyncLambdaLogGroup', {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
    });
    s3SyncLambda.role?.addToPrincipalPolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['s3:ListBucket', 's3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [
        `arn:aws:s3:::${props.envParams.deploymentTargetBucketName}`,
        `arn:aws:s3:::${props.envParams.deploymentTargetBucketName}/*`,
      ],
    }));
    const cloudfrontInvalidationLambda = new lambda.Function(this, 'CloudfrontInvalidationLambda', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(cloudfrontInvalidationLambdaPath),
      environment: {
        DISTRIBUTION_ID: props.envParams.cloudfrontDistributionId,
        TOPIC_ARN: InvalidationCompleteSnsTopic.topicArn,
      },
      logGroup: new logs.LogGroup(this, 'CloudfrontInvalidationLambdaLogGroup', {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
    });
    cloudfrontInvalidationLambda.role?.addToPrincipalPolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
      resources: [`arn:aws:cloudfront::${this.account}:distribution/${props.envParams.cloudfrontDistributionId}`],
    }));
    cloudfrontInvalidationLambda.role?.addToPrincipalPolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['sns:Publish'],
      resources: [InvalidationCompleteSnsTopic.topicArn],
    }));
    InvalidationCompleteSnsTopic.grantPublish(cloudfrontInvalidationLambda);

    const repository = codecommit.Repository.fromRepositoryName(this, 'CodeCommitRepo', props.envParams.repositoryName);

    // Create Artifact Bucket
    const artifactBucket = new cdk.aws_s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `${props.project}-${props.environment}-artifact-bucket`.toLowerCase(),
      removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: props.isAutoDeleteObject,
    });

    // LambdaInvokeAction only grants the pipeline role read access to the artifact
    // bucket, not the invoked Lambda's own execution role. The Lambda code itself
    // fetches the input artifact object from S3, so it needs read access too.
    artifactBucket.grantRead(s3SyncLambda);
    // Create Artifact for the source output
    const sourceOutput = new codepipeline.Artifact('SourceOutput');

    // Create Artifact for the build output
    // When the Build stage is disabled, no artifact is produced for it, so
    // downstream Deploy/Sync stages fall back to consuming the source artifact directly.
    const buildOutput = props.envParams.enableBuild ? new codepipeline.Artifact('BuildOutput') : sourceOutput;

    // Fixed (non-token) pipeline name, reused below instead of `pipeline.pipelineName` —
    // referencing the Pipeline's own `Ref` from inside one of its own stage configurations
    // (the InvalidateCache Lambda action) would create a self-referencing dependency cycle.
    const pipelineName = `${props.project}-${props.environment}-pipeline`;

    // Create a CodePipeline to build and deploy the static website to S3
    // Note: no custom pipeline role is passed here — CDK grants each action's
    // required permissions (scoped to the specific resource ARNs) onto the
    // pipeline's auto-created role as stages are added below.
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: pipelineName,
      restartExecutionOnUpdate: true,
      artifactBucket: artifactBucket,
    });

    // add Lambda Environment Variables for the Invalidation Lambda
    cloudfrontInvalidationLambda.addEnvironment('PIPELINE_NAME', pipelineName);

    // Source stage to pull code from CodeCommit repository
    pipeline.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_action.CodeCommitSourceAction({
          runOrder: 1,
          actionName: 'CodeCommit_Source',
          repository: repository,
          output: sourceOutput,
          branch: props.envParams.repositoryBranch,
        }),
      ],
    });

    // CodeBuild project to build the static website
    // Deployment to S3 is handled by the later Deploy/Sync pipeline stages, not here.
    if (props.envParams.enableBuild) {
      const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
        projectName: `${props.project}-${props.environment}-build`,
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          computeType: codebuild.ComputeType.SMALL,
          privileged: true,
          environmentVariables: {
            'PROJECT_NAME': { 
              type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
              value: props.project
            },
            'ENVIRONMENT': { 
              type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
              value: props.environment
            },
          },
        },
        logging: {
          cloudWatch: {
            logGroup: new logs.LogGroup(this, 'BuildProjectLogGroup', {
              retention: logs.RetentionDays.ONE_WEEK,
              removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
          },
        },
        buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
      });

      // Build stage to build and deploy the static website to S3
      pipeline.addStage({
        stageName: 'Build',
        actions: [
          new codepipeline_action.CodeBuildAction({
            runOrder: 2,
            actionName: 'CodeBuild_Build',
            project: buildProject,
            input: sourceOutput,
            outputs: [buildOutput],
          }),
        ],
      });
    }

    // Optional approval stage before deployment (skipped when no approval topic is configured)
    if (props.envParams.approvalTopicArn) {
      pipeline.addStage({
        stageName: 'Approval',
        actions: [
          new codepipeline_action.ManualApprovalAction({
            actionName: 'Manual_Approval',
            notificationTopic: cdk.aws_sns.Topic.fromTopicArn(this, 'ApprovalTopic', props.envParams.approvalTopicArn),
            runOrder: 10,
          }),
        ],
      });
    }

    // Deployment stage to deploy the static website to S3
    pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        new codepipeline_action.S3DeployAction({
          runOrder: 11,
          actionName: 'S3_Deploy',
          bucket: cdk.aws_s3.Bucket.fromBucketName(this, 'TargetBucket', props.envParams.deploymentTargetBucketName),
          input: buildOutput,
        }),
      ],
    });

    // S3 Sync Lambda function to deploy the static website to S3
    pipeline.addStage({
      stageName: 'Sync',
      actions: [
        new codepipeline_action.LambdaInvokeAction({
          runOrder: 12,
          actionName: 'Lambda_S3_Sync',
          lambda: s3SyncLambda,
          inputs: [buildOutput],
          userParameters: {
            "DEST_BUCKET_NAME": props.envParams.deploymentTargetBucketName,
          },
        }),
      ],
    });

    // CloudFront Invalidation Lambda function to invalidate the CloudFront cache
    pipeline.addStage({
      stageName: 'InvalidateCache',
      actions: [
        new codepipeline_action.LambdaInvokeAction({
          runOrder: 13,
          actionName: 'Lambda_CloudFront_Invalidate',
          lambda: cloudfrontInvalidationLambda,
          userParameters: {
            "PIPELINE_NAME": pipelineName,
            "DISTRIBUTION_ID": props.envParams.cloudfrontDistributionId,
            "TOPIC_ARN": props.envParams.approvalTopicArn || '',
          },
        }),
      ],
    });

    // CodeStarNotifications requires at least one target, so only create the rule
    // when a notification topic is actually configured for this environment.
    if (props.envParams.approvalTopicArn) {
      new codestar_notification.NotificationRule(this, 'PipelineNotificationRule', {
        notificationRuleName: `${props.project}-${props.environment}-pipeline-notification`,
        detailType: codestar_notification.DetailType.FULL,
        events: [
          codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_SUCCEEDED,
          codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_FAILED,
          codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_CANCELED,
        ],
        source: pipeline,
        targets: [
          sns.Topic.fromTopicArn(this, 'NotificationTopic', props.envParams.approvalTopicArn),
        ],
      });
    }

    // Tagging the stack with project and environment information
    cdk.Tags.of(this).add('Repository', props.envParams.repositoryName);
    cdk.Tags.of(this).add('Branch', props.envParams.repositoryBranch);
    cdk.Tags.of(this).add('DeploymentTargetBucket', props.envParams.deploymentTargetBucketName);
  }
}
