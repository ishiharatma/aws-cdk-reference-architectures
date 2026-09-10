import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams, SharedParams } from 'lib/types';

export interface PipelineStackProps extends cdk.StackProps {
  readonly project: string;
  readonly isAutoDeleteObject: boolean;
  readonly sharedParams: SharedParams;
  /** Parameters for every environment (dev/stg/prd) — each gets its own pipeline. */
  readonly envParamsMap: Partial<Record<Environment, EnvParams>>;
}

/**
 * CodeCommit + Pipeline Stack
 *
 * Deployed once, into the dev account. Creates:
 * - The CodeCommit repository (seeded with the sample app on `main`), plus
 *   `develop`/`staging` branches auto-created from that same initial commit
 * - Three CodePipelines (dev/stg/prd), one per branch, each running
 *   Source → Test → Build → (optional Approve) → Deploy
 *
 * All three pipelines run in this (dev) account. Only the Deploy stage's
 * CodeBuild project crosses accounts, by assuming the role created in the
 * matching target account by CrossAccountRoleStack.
 */
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const devAccountId = cdk.Stack.of(this).account;

    /* ─── CodeCommit repository, seeded with the sample app ─────────────*/
    const repository = new codecommit.Repository(this, 'Repository', {
      repositoryName: props.sharedParams.repositoryName,
      description: `${props.project} sample application repository for the cross-account CI/CD demo`,
      code: codecommit.Code.fromDirectory(path.join(__dirname, '../../sample-app'), 'main'),
    });

    /* ─── Auto-create develop/staging branches from main's initial commit ──
     * codecommit.Code.fromDirectory only seeds a single branch (main).
     * develop/staging are created here, pointing at that same commit, so a
     * fresh `cdk deploy` leaves all three branches ready to receive pushes.
     */
    const getMainBranch = new cr.AwsCustomResource(this, 'GetMainBranch', {
      onCreate: {
        service: 'CodeCommit',
        action: 'getBranch',
        parameters: {
          repositoryName: repository.repositoryName,
          branchName: 'main',
        },
        physicalResourceId: cr.PhysicalResourceId.of('GetMainBranch'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [repository.repositoryArn] }),
    });
    // No explicit node.addDependency(repository) here: Repository.onCommit()
    // (used internally by CodeCommitSourceAction's EventBridge trigger below)
    // adds its Rule as a CHILD of the repository construct. A construct-level
    // dependency on `repository` would therefore transitively depend on that
    // Rule too — which targets the pipeline, which in turn depends on the
    // branch-creation custom resources below, creating a cycle. The IAM
    // policy above already references `repository.repositoryArn`, which is
    // enough for CloudFormation to sequence this after the repository exists.
    const mainCommitId = getMainBranch.getResponseField('branch.commitId');

    const branchCreations: Record<string, cr.AwsCustomResource> = {};
    for (const branchName of ['develop', 'staging']) {
      const createBranch = new cr.AwsCustomResource(this, `CreateBranch${pascalCase(branchName)}`, {
        onCreate: {
          service: 'CodeCommit',
          action: 'createBranch',
          parameters: {
            repositoryName: repository.repositoryName,
            branchName,
            // Referencing mainCommitId (a token from GetMainBranch's response)
            // is enough to sequence this after GetMainBranch — no explicit
            // node.addDependency() needed (see note above).
            commitId: mainCommitId,
          },
          physicalResourceId: cr.PhysicalResourceId.of(`CreateBranch-${branchName}`),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [repository.repositoryArn] }),
      });
      branchCreations[branchName] = createBranch;
    }

    /* ─── One pipeline per environment ───────────────────────────────*/
    const targetEnvs: Environment[] = [Environment.DEVELOPMENT, Environment.STAGING, Environment.PRODUCTION];
    for (const targetEnv of targetEnvs) {
      const envParams = props.envParamsMap[targetEnv];
      if (!envParams) {
        continue;
      }
      const pipeline = this.createPipeline(props, devAccountId, repository, targetEnv, envParams);
      const branchDependency = branchCreations[envParams.branchName];
      if (branchDependency) {
        pipeline.node.addDependency(branchDependency);
      }
    }

    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-S1',
          reason: 'These are pipeline artifact buckets for a sample workspace; server access logging is not required for the demo.',
        },
        {
          id: 'AwsSolutions-CB4',
          reason: 'Test/Build/Deploy CodeBuild projects use the default AWS-managed encryption key rather than a customer-managed KMS key, matching this repo\'s other CI/CD reference workspaces (e.g. cicd-cloudfront-s3).',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole (used by the CDK-provided AwsCustomResource singleton Lambda for the branch-creation custom resources) is acceptable for this sample.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Wildcard permissions here are CDK auto-grants scoped as narrowly as each API allows: CodePipeline/CodeBuild action roles need bucket/* object-level S3 access and lambda:ListFunctions; the branch-creation custom resource Lambda needs CloudWatch Logs log-stream wildcards; CodeCommit GetBranch/CreateBranch are scoped to this one repository ARN.',
        },
      ],
      true
    );
  }

  private createPipeline(
    props: PipelineStackProps,
    devAccountId: string,
    repository: codecommit.IRepository,
    targetEnv: Environment,
    envParams: EnvParams
  ): codepipeline.Pipeline {
    const { project, isAutoDeleteObject } = props;
    const logRetentionDays = logs.RetentionDays.ONE_MONTH;
    const targetAccountId = envParams.accountId ?? devAccountId;
    const deployBuildRoleName = `${project}-${targetEnv}-deploy-build-role`;
    const crossAccountRoleArn = `arn:aws:iam::${targetAccountId}:role/${project}-${targetEnv}-cross-account-deploy-role`;

    /* ─── Artifact bucket (one per environment pipeline) ─────────────*/
    const artifactBucket = new s3.Bucket(this, `ArtifactBucket${pascalCase(targetEnv)}`, {
      bucketName: `${project}-${targetEnv}-cicd-artifact-${devAccountId}`.toLowerCase(),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: isAutoDeleteObject,
    });

    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const buildOutput = new codepipeline.Artifact('BuildOutput');

    const commonEnvVars: Record<string, codebuild.BuildEnvironmentVariable> = {
      PROJECT: { value: project },
      ENV: { value: targetEnv },
      TARGET_BRANCH: { value: envParams.branchName },
    };

    /* ─── CodeBuild: Test ─────────────────────────────────────────*/
    const testProject = new codebuild.PipelineProject(this, `TestProject${pascalCase(targetEnv)}`, {
      projectName: `${project}-${targetEnv}-test`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec-test.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: commonEnvVars,
      },
      logging: {
        cloudWatch: {
          logGroup: new logs.LogGroup(this, `TestLogGroup${pascalCase(targetEnv)}`, {
            logGroupName: `/${project}/${targetEnv}/codebuild/test`,
            retention: logRetentionDays,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        },
      },
    });

    /* ─── CodeBuild: Build ────────────────────────────────────────*/
    const buildProject = new codebuild.PipelineProject(this, `BuildProject${pascalCase(targetEnv)}`, {
      projectName: `${project}-${targetEnv}-build`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec-build.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: commonEnvVars,
      },
      logging: {
        cloudWatch: {
          logGroup: new logs.LogGroup(this, `BuildLogGroup${pascalCase(targetEnv)}`, {
            logGroupName: `/${project}/${targetEnv}/codebuild/build`,
            retention: logRetentionDays,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        },
      },
    });

    /* ─── CodeBuild: Deploy (the cross-account hop) ──────────────────
     * Uses a fixed-name role so CrossAccountRoleStack (deployed separately,
     * into the targetEnv account) can trust it by name in its own
     * AssumeRolePolicy — see lib/stacks/cross-account-role-stack.ts.
     */
    const deployRole = new iam.Role(this, `DeployBuildRole${pascalCase(targetEnv)}`, {
      roleName: deployBuildRoleName,
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description: `${project} ${targetEnv} Deploy CodeBuild project role - assumes ${crossAccountRoleArn} to deploy`,
    });
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowAssumeCrossAccountDeployRole',
        actions: ['sts:AssumeRole'],
        resources: [crossAccountRoleArn],
      })
    );

    const deployProject = new codebuild.PipelineProject(this, `DeployProject${pascalCase(targetEnv)}`, {
      projectName: `${project}-${targetEnv}-deploy`,
      role: deployRole,
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec-deploy.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: {
          ...commonEnvVars,
          TARGET_ENV: { value: targetEnv },
          TARGET_ACCOUNT_ID: { value: targetAccountId },
          CROSS_ACCOUNT_ROLE_ARN: { value: crossAccountRoleArn },
        },
      },
      logging: {
        cloudWatch: {
          logGroup: new logs.LogGroup(this, `DeployLogGroup${pascalCase(targetEnv)}`, {
            logGroupName: `/${project}/${targetEnv}/codebuild/deploy`,
            retention: logRetentionDays,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        },
      },
    });
    NagSuppressions.addResourceSuppressions(
      deployRole,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole-equivalent CodeBuild managed policy is out of scope here; only the explicit AssumeRole statement above is hand-written.',
        },
      ],
      true
    );

    /* ─── Pipeline stages ────────────────────────────────────────*/
    const stages: codepipeline.StageProps[] = [
      {
        stageName: 'Source',
        actions: [
          new codepipeline_actions.CodeCommitSourceAction({
            actionName: 'Source',
            repository,
            branch: envParams.branchName,
            output: sourceOutput,
          }),
        ],
      },
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
              ? sns.Topic.fromTopicArn(this, `ApprovalTopic${pascalCase(targetEnv)}`, envParams.approvalTopicArn)
              : undefined,
            additionalInformation: `Approve deployment of ${project} to the ${targetEnv} account`,
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

    const pipeline = new codepipeline.Pipeline(this, `Pipeline${pascalCase(targetEnv)}`, {
      pipelineName: `${project}-${targetEnv}-pipeline`,
      artifactBucket,
      stages,
    });

    return pipeline;
  }
}
