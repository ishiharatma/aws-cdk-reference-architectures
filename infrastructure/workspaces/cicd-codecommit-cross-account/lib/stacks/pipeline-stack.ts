import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { EnvParams, SharedParams } from 'lib/types';
import { pipelineRoleName, sourceActionRoleName } from 'lib/stacks/naming';

export interface PipelineStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly sharedParams: SharedParams;
  readonly envParams: EnvParams;
}

/**
 * Pipeline Stack
 *
 * Deployed once PER ENVIRONMENT, into THAT environment's own account
 * (dev/stg/prd) — this is the cross-account part of the architecture: the
 * pipeline itself lives next to whatever it deploys, not in the dev account
 * alongside CodeCommit.
 *
 * Runs Source → Test → Build → (optional Approve) → Deploy, all within this
 * one account. Only the Source stage crosses accounts (for stg/prd, whose
 * CodeCommit repository lives in the dev account):
 * - `CodeCommitSourceAction.role` is set to the fixed-name role that
 *   RepositoryStack created in the dev account for this account to assume
 * - Since CodeCommit only emits push events in the account that owns the
 *   repository, RepositoryStack forwards them to this account's default
 *   event bus; this stack's own EventBridge rule reacts to that forwarded
 *   event to start the pipeline (a plain EventBridge rule on the resource
 *   ARN works for the dev environment, which owns the repository directly)
 */
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const { project, environment, envParams, sharedParams, isAutoDeleteObject } = props;
    const accountId = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;
    const logRetentionDays = logs.RetentionDays.ONE_MONTH;

    const codecommitAccountId = sharedParams.codecommitAccountId ?? accountId;
    const isCrossAccountSource = codecommitAccountId !== accountId;

    /* ─── Pipeline execution role (fixed name — trusted by name from the
     * dev account's RepositoryStack when this is a cross-account source) ──*/
    const pipelineRole = new iam.Role(this, 'PipelineRole', {
      roleName: pipelineRoleName(project, environment),
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
      description: `${project}-${environment} CodePipeline execution role`,
    });

    /* ─── CodeCommit repository reference ────────────────────────────*/
    const repository: codecommit.IRepository = isCrossAccountSource
      ? codecommit.Repository.fromRepositoryArn(
          this,
          'Repository',
          `arn:aws:codecommit:${region}:${codecommitAccountId}:${sharedParams.repositoryName}`
        )
      : codecommit.Repository.fromRepositoryName(this, 'Repository', sharedParams.repositoryName);

    /* ─── Artifact bucket ─────────────────────────────────────────*/
    // A cross-account Source action requires the artifact bucket to be
    // encrypted with a customer-managed KMS key (CodePipeline needs to grant
    // the other account's source-action role decrypt/encrypt access to it) —
    // S3-managed encryption is only sufficient for same-account pipelines.
    const artifactKey = isCrossAccountSource
      ? new kms.Key(this, 'ArtifactBucketKey', {
          description: `${project}-${environment} pipeline artifact bucket encryption key`,
          enableKeyRotation: true,
          removalPolicy: isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
        })
      : undefined;
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `${project}-${environment}-cicd-artifact-${accountId}`.toLowerCase(),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: artifactKey ? s3.BucketEncryption.KMS : s3.BucketEncryption.S3_MANAGED,
      encryptionKey: artifactKey,
      enforceSSL: true,
      removalPolicy: isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: isAutoDeleteObject,
    });

    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const buildOutput = new codepipeline.Artifact('BuildOutput');

    const commonEnvVars: Record<string, codebuild.BuildEnvironmentVariable> = {
      PROJECT: { value: project },
      ENV: { value: environment },
      TARGET_BRANCH: { value: envParams.branchName },
    };

    /* ─── CodeBuild: Test ─────────────────────────────────────────*/
    const testProject = new codebuild.PipelineProject(this, 'TestProject', {
      projectName: `${project}-${environment}-test`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec-test.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: commonEnvVars,
      },
      logging: {
        cloudWatch: {
          logGroup: new logs.LogGroup(this, 'TestLogGroup', {
            logGroupName: `/${project}/${environment}/codebuild/test`,
            retention: logRetentionDays,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        },
      },
    });

    /* ─── CodeBuild: Build ────────────────────────────────────────*/
    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: `${project}-${environment}-build`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec-build.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: commonEnvVars,
      },
      logging: {
        cloudWatch: {
          logGroup: new logs.LogGroup(this, 'BuildLogGroup', {
            logGroupName: `/${project}/${environment}/codebuild/build`,
            retention: logRetentionDays,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        },
      },
    });

    /* ─── CodeBuild: Deploy ───────────────────────────────────────
     * Runs entirely within this account now — the pipeline itself already
     * lives next to whatever it deploys, so no further AssumeRole hop is
     * needed here (contrast with a design where the pipeline stays in the
     * dev account and only Deploy crosses accounts).
     */
    const deployProject = new codebuild.PipelineProject(this, 'DeployProject', {
      projectName: `${project}-${environment}-deploy`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec-deploy.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: commonEnvVars,
      },
      logging: {
        cloudWatch: {
          logGroup: new logs.LogGroup(this, 'DeployLogGroup', {
            logGroupName: `/${project}/${environment}/codebuild/deploy`,
            retention: logRetentionDays,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        },
      },
    });

    /* ─── Source action: cross-account only for stg/prd ─────────────*/
    const sourceAction = new codepipeline_actions.CodeCommitSourceAction({
      actionName: 'Source',
      repository,
      branch: envParams.branchName,
      output: sourceOutput,
      // A dedicated EventBridge rule (below) starts the pipeline instead —
      // required for the cross-account case (CodeCommit events only exist in
      // the account that owns the repository) and used uniformly here so
      // dev/stg/prd all follow the same trigger path.
      trigger: codepipeline_actions.CodeCommitTrigger.NONE,
      role: isCrossAccountSource
        ? iam.Role.fromRoleArn(
            this,
            'SourceActionRole',
            `arn:aws:iam::${codecommitAccountId}:role/${sourceActionRoleName(project, accountId)}`
          )
        : undefined,
    });

    /* ─── Pipeline stages ────────────────────────────────────────*/
    const stages: codepipeline.StageProps[] = [
      { stageName: 'Source', actions: [sourceAction] },
      {
        stageName: 'Test',
        actions: [
          new codepipeline_actions.CodeBuildAction({
            actionName: 'Test',
            project: testProject,
            input: sourceOutput,
          }),
        ],
      },
      {
        stageName: 'Build',
        actions: [
          new codepipeline_actions.CodeBuildAction({
            actionName: 'Build',
            project: buildProject,
            input: sourceOutput,
            outputs: [buildOutput],
          }),
        ],
      },
    ];

    if (envParams.requireManualApproval) {
      stages.push({
        stageName: 'Approve',
        actions: [
          new codepipeline_actions.ManualApprovalAction({
            actionName: 'Approve',
            notificationTopic: envParams.approvalTopicArn
              ? sns.Topic.fromTopicArn(this, 'ApprovalTopic', envParams.approvalTopicArn)
              : undefined,
            additionalInformation: `Approve deployment of ${project} to the ${environment} account`,
          }),
        ],
      });
    }

    stages.push({
      stageName: 'Deploy',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Deploy',
          project: deployProject,
          input: sourceOutput,
          extraInputs: [buildOutput],
        }),
      ],
    });

    const pipeline = new codepipeline.Pipeline(this, 'Resource', {
      pipelineName: `${project}-${environment}-pipeline`,
      role: pipelineRole,
      artifactBucket,
      stages,
    });

    /* ─── Pipeline trigger ──────────────────────────────────────────
     * Same-account (dev): react to this repository's own push events.
     * Cross-account (stg/prd): react to the events RepositoryStack forwards
     * into this account's default event bus — first authorizing the dev
     * account to publish onto it.
     */
    if (isCrossAccountSource) {
      new events.CfnEventBusPolicy(this, 'AllowRepositoryAccountPutEvents', {
        statementId: `Allow-${codecommitAccountId}-PutEvents`,
        statement: {
          Effect: 'Allow',
          Principal: { AWS: `arn:aws:iam::${codecommitAccountId}:root` },
          Action: 'events:PutEvents',
          Resource: `arn:aws:events:${region}:${accountId}:event-bus/default`,
        },
      });
    }

    const triggerRule = new events.Rule(this, 'PipelineTriggerRule', {
      ruleName: `${project}-${environment}-pipeline-trigger`,
      eventPattern: {
        source: ['aws.codecommit'],
        detailType: ['CodeCommit Repository State Change'],
        // Cross-account: the forwarded event still carries the dev account's
        // repository ARN, so this filter works unchanged in both cases.
        resources: [`arn:aws:codecommit:${region}:${codecommitAccountId}:${sharedParams.repositoryName}`],
        detail: {
          event: ['referenceCreated', 'referenceUpdated'],
          referenceType: ['branch'],
          referenceName: [envParams.branchName],
        },
      },
    });
    triggerRule.addTarget(new events_targets.CodePipeline(pipeline));

    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-S1',
          reason: 'This is a pipeline artifact bucket for a sample workspace; server access logging is not required for the demo.',
        },
        {
          id: 'AwsSolutions-CB4',
          reason: "Test/Build/Deploy CodeBuild projects use the default AWS-managed encryption key rather than a customer-managed KMS key, matching this repo's other CI/CD reference workspaces (e.g. cicd-cloudfront-s3).",
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Wildcard permissions here are CDK auto-grants scoped as narrowly as each API allows: CodePipeline/CodeBuild action roles need bucket/* object-level S3 access and lambda:ListFunctions; EventBridge target roles need PutEvents/StartPipelineExecution scoped to this one rule/pipeline.',
        },
      ],
      true
    );
  }
}
