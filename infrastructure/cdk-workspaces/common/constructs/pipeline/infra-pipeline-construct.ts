/**
 * Infra Pipeline Construct
 *
 * CI pipeline triggered by pushes to the infra CDK repository (<project>-infra).
 * There is no deploy stage; only lint / cdk synth / Jest tests are run.
 * Deployment is performed manually via `cdk deploy`.
 *
 * ## Pipeline structure
 * ```
 * Stage 1: Source  ← CodeCommit <project>-infra (branch switches based on env)
 * Stage 2: Test    ← CodeBuild: npm ci / lint / cdk synth / npm test
 * ```
 *
 * ## Cross-account notes
 * In the dev / stage environments, CodeCommit is located in the prod account.
 * The CodePipeline execution role must be manually granted cross-account
 * CodeCommit reference permissions.
 * CommitConstruct forwards branch push events via EventBridge.
 */
import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { Environment } from '../../parameters/environments';
import { createPathFilterTrigger, getBranchName } from './pipeline-utils';

/**
 * InfraPipelineConstruct properties
 */
export interface InfraPipelineConstructProps {
  /** Project identifier */
  readonly project: string;
  /** Environment identifier */
  readonly environment: Environment;
  /**
   * AWS account ID where the CodeCommit repository is located.
   * If not specified, the current account is used.
   */
  readonly codecommitAccountId?: string;
  /**
   * CodePipeline execution role.
   * The role name must be fixed to `<project>-<env>-pipeline-role` (required for cross-account reference).
   */
  readonly pipelineRole: iam.IRole;
  /** Shared S3 artifact bucket for the pipeline */
  readonly artifactBucket: s3.IBucket;
  /** SNS topic for pipeline failure notifications */
  readonly notificationTopic: sns.ITopic;
  /** 
   * CloudWatch Logs retention period (CodeBuild logs)
   * @default logs.RetentionDays.THREE_MONTHS
   */
  readonly logRetentionDays?: logs.RetentionDays;
  /** 
   * Target directories for the pipeline trigger (default: infra/) 
   * @default ['infra/']
  */
  readonly targetDirs?: string[];
  /**
   * Repository name for the infra CDK repository (default: <project>-infra)
   * @default <project>-infra
   */
  readonly repositoryName?: string;
  /**
   * BuildSpec path for the infra-test CodeBuild project.
   * If not specified, the default is `infra` in the <project>-infra repository.
   * This file should contain the build commands for linting, synthesizing, and testing the CDK app.
   * @default `infra`
   */
  readonly buildSpecPath?: string;
  /**
   * BuildSpec path for the infra-test CodeBuild project.
   * If not specified, the default is `buildspec-ci.yml` in the <project>-infra repository.
   * This file should contain the build commands for linting, synthesizing, and testing the CDK app.
   * @default `buildspec-ci.yml`
   */
  readonly buildSpecFileName?: string;

  /**
   * IAM role for the CodeCommit source action when the repository is in a different account.
   */
  readonly sourceActionRole?: iam.IRole;
}

/**
 * Infra Pipeline Construct
 * Manages the infra CI pipeline (Source + Test). No DevStack required.
 */
export class InfraPipelineConstruct extends Construct {
  /** Infra CI pipeline */
  public readonly pipeline: codepipeline.IPipeline;
  /** Infra test CodeBuild project */
  public readonly testProject: codebuild.IProject;

  /**
   * InfraPipelineConstruct constructor
   * @param scope - Parent Construct
   * @param id - Construct ID
   * @param props - Properties
   */
  constructor(scope: Construct, id: string, props: InfraPipelineConstructProps) {
    super(scope, id);

    const {
      project,
      environment,
      codecommitAccountId,
      pipelineRole,
      artifactBucket,
      notificationTopic,
      logRetentionDays = logs.RetentionDays.THREE_MONTHS,
    } = props;
    const stack = cdk.Stack.of(this);
    const actualCodecommitAccountId = codecommitAccountId ?? stack.account;
    const isCrossAccount = actualCodecommitAccountId !== stack.account;
    const repositoryName = props.repositoryName ?? `${project}-infra`;
    const buildspecBasePath = props.buildSpecPath ?? 'infra';
    const buildspecFileName = props.buildSpecFileName ?? 'buildspec-ci.yml';

    if (isCrossAccount && !props.sourceActionRole) {
      throw new Error(
        `Cross-account CodeCommit repository detected (account: ${actualCodecommitAccountId}). ` +
        `Please specify the sourceActionRole property for the CodeCommit source action.`
      );
    }

    /* ─── Source artifact ─────────────────────────────────────*/
    const sourceOutput = new codepipeline.Artifact('SourceArtifact');

    /* ─── CodeCommit repository reference ──────────────────────────────────*/
    const infraRepo = codecommit.Repository.fromRepositoryArn(
      this,
      'InfraRepo',
      `arn:aws:codecommit:${stack.region}:${actualCodecommitAccountId}:${repositoryName}`
    );

    /* ─── CodeBuild: infra-test ───────────────────────────────────────
     * Runs npm ci / lint / cdk synth / npm test.
     * buildspec refers to infra/buildspec-ci.yml in the <project>-infra repository.
     */
    const testLogGroup = new logs.LogGroup(this, 'TestLogGroup', {
      logGroupName: `/${project}/${environment}/codebuild/infra-test`,
      retention: logRetentionDays,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const testProject = new codebuild.PipelineProject(this, 'TestProject', {
      projectName: `${project}-${environment}-infra-test`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename(`${buildspecBasePath}/${buildspecFileName}`),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        environmentVariables: {
          PROJECT: { value: project },
          ENV: { value: environment },
          /* Leave CDK_PROFILE empty to use the CodeBuild instance role */
          CDK_PROFILE: { value: '' },
        },
      },
      logging: {
        cloudWatch: { logGroup: testLogGroup },
      },
    });
    this.testProject = testProject;

    /* ─── CodePipeline ───────────────────────────────────────────────*/
    const pipeline = new codepipeline.Pipeline(this, 'Resource', {
      pipelineName: `${project}-${environment}-infra-pipeline`,
      role: pipelineRole,
      artifactBucket: artifactBucket,
      stages: [
        /* Stage 1: Source */
        {
          stageName: 'Source',
          actions: [
            new codepipeline_actions.CodeCommitSourceAction({
              actionName: 'Source',
              repository: infraRepo,
              branch: getBranchName(environment),
              output: sourceOutput,
              /* Use NONE since the Lambda path-change detection trigger fires instead.
               * Explicitly specifying role makes CDK's actionProperties.account undefined,
               * which suppresses auto-generation of the cross-account support stack. */
              trigger: codepipeline_actions.CodeCommitTrigger.NONE,
              role: isCrossAccount
                ? props.sourceActionRole
                : undefined,
            }),
          ],
        },
        /* Stage 2: Test (lint / cdk synth / npm test) */
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
      ],
    });
    this.pipeline = pipeline;

    /* ─── Additional CodeBuild IAM permissions ──────────────────────────────────*/
    /* Only cdk synth / tsc are run, so additional permissions are minimal.
     * If SSM context lookup becomes necessary, add the required permissions below.
     * TODO: add a policy if cdk synth requires SSM lookup */
    testProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSsmGetParameters',
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
        resources: [`arn:aws:ssm:${stack.region}:${stack.account}:parameter/${project}/*`],
      })
    );

    /* ─── Pipeline failure notification ────────────────────────────────────────*/
    pipeline.notifyOn('FailureNotification', notificationTopic, {
      events: [codepipeline.PipelineNotificationEvents.STAGE_EXECUTION_FAILED],
      notificationRuleName: `${project}-${environment}-infra-pipeline-failure`,
    });

    /* ─── Path-change detection trigger (via Lambda) ─────────────────────
     * EventBridge → Lambda → CodePipeline:StartPipelineExecution
     * Only starts the pipeline when there are changes under infra/.
     */
    createPathFilterTrigger(this, 'InfraPathFilter', {
      ruleName: `${project}-${environment}-infra-pipeline-trigger`,
      functionName: `${project}-${environment}-infra-path-filter`,
      repository: infraRepo,
      pipeline,
      branchName: getBranchName(environment),
      pathPrefixes: props.targetDirs ?? ['infra/'],
      logRetentionDays,
      crossAccountRoleArn: isCrossAccount
        ? props.sourceActionRole?.roleArn
        : undefined,
    });
  }
}
