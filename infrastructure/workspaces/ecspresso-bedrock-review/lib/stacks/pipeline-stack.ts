import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { SharedParams, EnvParams } from 'lib/types';

// Mirrors PERSPECTIVES_BY_LANGUAGE ids / RISK_LEVELS in
// backend/ecspresso-bedrock-review-app/scripts/agentic-review.js -- these
// drive the dashboard's per-perspective / per-risk-level widgets and must
// stay in sync with the metric dimensions that script actually publishes.
const REVIEW_PERSPECTIVE_IDS = ['security', 'infra', 'quality', 'cost'];
const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];

/** PipelineStack properties. */
export interface PipelineStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: string;
  readonly isAutoDeleteObject: boolean;
  readonly sharedParams: SharedParams;
  readonly envParams: EnvParams;
  readonly repository: codecommit.IRepository;
}

/**
 * Pipeline Stack
 *
 * Source(CodeCommit) -> Test -> Build -> AgenticReview(Bedrock) -> [Approve] -> Deploy(ecspresso)
 *
 * AgenticReview reviews the git diff with Amazon Bedrock in pseudo-parallel
 * across multiple perspectives (security/infra/quality/cost), and fails the
 * CodeBuild project (blocking the pipeline) when the overall risk level is
 * at or above RISK_THRESHOLD.
 *
 * Deploy (ecspresso + jsonnet) never runs `ecspresso verify` / `ecspresso
 * deploy` (both call AWS APIs), since this setup has no real ECS
 * cluster/service behind it -- it only runs the purely local `ecspresso
 * render` (see buildspec-deploy.yml).
 */
export class PipelineStack extends cdk.Stack {
  public readonly pipeline: codepipeline.IPipeline;

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const { project, environment, envParams, isAutoDeleteObject, repository } = props;
    const accountId = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;
    const logRetentionDays = logs.RetentionDays.ONE_MONTH;
    const riskThreshold = envParams.riskThreshold ?? 'high';

    /* ─── ECR repository ────────────────────────────────────────────*/
    const ecrRepository = new ecr.Repository(this, 'EcrRepository', {
      repositoryName: `${project}-${environment}-api`,
      imageScanOnPush: true,
      removalPolicy: isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      emptyOnDelete: isAutoDeleteObject,
      lifecycleRules: [{ maxImageCount: 20 }],
    });

    /* ─── SSM Parameter Store: ECS cluster/service info ──────────────
     * This sample has no real ECS behind it, so these are placeholder values.
     * If you point this at a real cluster, overwrite them with the outputs
     * of the corresponding ECS/VPC stack.
     */
    const ssmPrefix = `/${project}/${environment}/ecs`;
    const ssmPlaceholders: Record<string, string> = {
      'cluster-name': `${project}-${environment}-cluster`,
      'service-name': `${project}-${environment}-api`,
      'execution-role-arn': `arn:aws:iam::${accountId}:role/REPLACE_ME-execution-role`,
      'task-role-arn': `arn:aws:iam::${accountId}:role/REPLACE_ME-task-role`,
      'subnet-ids': 'subnet-00000000000000000,subnet-11111111111111111',
      'security-group-ids': 'sg-00000000000000000',
      'target-group-arn': '',
    };
    for (const [key, value] of Object.entries(ssmPlaceholders)) {
      new ssm.StringParameter(this, `SsmParam${key.replace(/[^a-zA-Z0-9]/g, '')}`, {
        parameterName: `${ssmPrefix}/${key}`,
        stringValue: value || 'UNSET',
        description: `Placeholder for ${key} (this sample has no real ECS cluster/service)`,
      });
    }

    /* ─── Pipeline failure notifications ─────────────────────────────*/
    const notificationTopic = new sns.Topic(this, 'NotificationTopic', {
      topicName: `${project}-${environment}-pipeline-notifications`,
      enforceSSL: true,
    });

    /* ─── Artifacts ────────────────────────────────────────────────*/
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `${project}-${environment}-cicd-artifact-${accountId}`.toLowerCase(),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: isAutoDeleteObject,
    });

    const sourceOutput = new codepipeline.Artifact('SourceArtifact');
    const buildOutput = new codepipeline.Artifact('BuildArtifact');
    const reviewOutput = new codepipeline.Artifact('AgenticReviewOutput');

    // Where to send the agentic review summary when reviewNotificationEnabled
    // is on: the dedicated approval topic if one is configured (most likely
    // to reach whoever will act on the Approve stage), otherwise the
    // pipeline's own notification topic.
    const reviewNotificationTopicArn = envParams.approvalTopicArn ?? notificationTopic.topicArn;

    // CloudWatch namespace agentic-review.js publishes effect-measurement
    // metrics to (risk level breakdown, block rate, Bedrock call
    // reliability/latency/token usage) -- see the AgenticReviewDashboard
    // built near the end of this constructor.
    const metricsNamespace = `${project}/${environment}/AgenticReview`;

    const commonEnvVars: Record<string, codebuild.BuildEnvironmentVariable> = {
      PROJECT: { value: project },
      ENV: { value: environment },
    };

    /* ─── CodeBuild: Test ────────────────────────────────────────*/
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

    /* ─── CodeBuild: Build (docker build + ECR push) ────────────────*/
    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: `${project}-${environment}-build`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec-build.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true,
        environmentVariables: {
          ...commonEnvVars,
          ECR_REPO_URI: { value: ecrRepository.repositoryUri },
          SECURITYHUB_IMPORT_ENABLED: { value: String(envParams.securityHubImportEnabled ?? false) },
        },
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
    buildProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowEcrGetAuthorizationToken',
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    );
    ecrRepository.grantPullPush(buildProject);
    /* Permissions needed for the Trivy -> ASFF conversion (sechub_parser.py).
     * BatchImportFindings has no resource-level ARN on the Security Hub side,
     * so '*' is required. It isn't called when SECURITYHUB_IMPORT_ENABLED=false
     * (the default), but the permission is granted unconditionally so this
     * can be toggled purely via the environment variable. */
    buildProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowStsGetCallerIdentity',
        actions: ['sts:GetCallerIdentity'],
        resources: ['*'],
      })
    );
    buildProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSecurityHubBatchImportFindings',
        actions: ['securityhub:BatchImportFindings'],
        resources: ['*'],
      })
    );
    NagSuppressions.addResourceSuppressions(
      buildProject,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'ECR GetAuthorizationToken, STS GetCallerIdentity, and Security Hub BatchImportFindings have no resource-level ARNs to scope to.',
        },
      ],
      true
    );

    /* ─── CodeBuild: AgenticReview (pseudo multi-agent review on Bedrock) ──
     * CodeCommitSourceAction only hands over a snapshot, so this project
     * re-clones CodeCommit with full history to compute the git diff
     * (see buildspec-review.yml).
     */
    const reviewProject = new codebuild.PipelineProject(this, 'AgenticReviewProject', {
      projectName: `${project}-${environment}-agentic-review`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec-review.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: {
          ...commonEnvVars,
          REPOSITORY_NAME: { value: repository.repositoryName },
          BEDROCK_MODEL_ID: { value: envParams.bedrockModelId },
          RISK_THRESHOLD: { value: riskThreshold },
          REVIEW_LANGUAGE: { value: envParams.reviewLanguage ?? 'en' },
          REVIEW_NOTIFICATION_ENABLED: { value: String(envParams.reviewNotificationEnabled ?? false) },
          REVIEW_NOTIFICATION_TOPIC_ARN: { value: reviewNotificationTopicArn },
          METRICS_NAMESPACE: { value: metricsNamespace },
        },
      },
      logging: {
        cloudWatch: {
          logGroup: new logs.LogGroup(this, 'AgenticReviewLogGroup', {
            logGroupName: `/${project}/${environment}/codebuild/agentic-review`,
            retention: logRetentionDays,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        },
      },
    });
    reviewProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCodeCommitPull',
        actions: ['codecommit:GitPull'],
        resources: [repository.repositoryArn],
      })
    );
    reviewProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowBedrockInvoke',
        actions: ['bedrock:InvokeModel'],
        resources: [
          // Cross-region inference profiles ("global.*", "jp.*", "apac.*", ...)
          // route InvokeModel to an underlying foundation-model resource whose
          // region can be this stack's own region, empty (confirmed via
          // `aws bedrock list-inference-profiles` for "global.*" profiles --
          // `models[].modelArn` is literally `arn:aws:bedrock:::foundation-model/...`),
          // or a *different* region entirely (e.g. a "jp.*" profile invoked from
          // ap-northeast-1 authorized against `arn:aws:bedrock:ap-northeast-3::
          // foundation-model/...`). A region-scoped resource pattern therefore
          // under-grants unpredictably; wildcard the region instead (the model-id
          // segment still scopes this to Bedrock foundation models specifically).
          'arn:aws:bedrock:*::foundation-model/*',
          `arn:aws:bedrock:${region}:${accountId}:inference-profile/*`,
        ],
      })
    );
    /* Lets the review post its summary to reviewNotificationTopicArn so a human
     * can see it before the Approve stage. Granted unconditionally (like the
     * Security Hub permission above) so REVIEW_NOTIFICATION_ENABLED is a pure
     * env var toggle; a no-op when it's false. */
    reviewProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSnsPublishReviewSummary',
        actions: ['sns:Publish'],
        resources: [reviewNotificationTopicArn],
      })
    );
    /* Effect-measurement metrics (risk level breakdown, block rate, Bedrock
     * latency/tokens/error rate). PutMetricData has no resource-level ARN to
     * scope to. Scoped down to this one namespace with a condition instead. */
    reviewProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchPutMetricData',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': metricsNamespace } },
      })
    );

    /* ─── CodeBuild: Deploy (ecspresso + jsonnet) ────────────────────
     * No real ECS cluster/service exists, so verify/deploy are never run
     * (see buildspec-deploy.yml). Only grants the permission needed to
     * resolve cluster/service etc. from SSM.
     */
    const deployProject = new codebuild.PipelineProject(this, 'DeployProject', {
      projectName: `${project}-${environment}-deploy`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec-deploy.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: {
          ...commonEnvVars,
          TASK_CPU: { value: String(envParams.ecsTaskCpu ?? 256) },
          TASK_MEMORY: { value: String(envParams.ecsTaskMemory ?? 512) },
          DESIRED_COUNT: { value: String(envParams.ecsDesiredCount ?? 1) },
          ENABLE_ECS_EXEC: { value: String(envParams.enableEcsExec ?? false) },
          // When true, ecs-service-def.jsonnet omits desiredCount, so deploy
          // no longer overwrites whatever value Application Auto Scaling has set.
          AUTO_SCALING_ENABLED: { value: String(envParams.autoScalingEnabled ?? false) },
          ECR_REPO_URI: { value: ecrRepository.repositoryUri },
        },
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
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSsmRead',
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${region}:${accountId}:parameter${ssmPrefix}/*`],
      })
    );

    /* ─── Assemble pipeline stages ───────────────────────────────────*/
    const stages: codepipeline.StageProps[] = [
      {
        stageName: 'Source',
        actions: [
          new codepipeline_actions.CodeCommitSourceAction({
            actionName: 'Source',
            repository,
            branch: envParams.branchName,
            output: sourceOutput,
            // Left at its EVENTS default, this action creates its own
            // CloudWatch Events rule to start the pipeline on push -- on
            // top of the explicit PipelineTriggerRule below (same
            // referenceCreated/referenceUpdated pattern), which fired the
            // pipeline twice per push. NONE disables the action's own
            // rule so PipelineTriggerRule is the single source of triggers.
            trigger: codepipeline_actions.CodeCommitTrigger.NONE,
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
      {
        stageName: 'AgenticReview',
        actions: [
          new codepipeline_actions.CodeBuildAction({
            actionName: 'BedrockAgenticReview',
            project: reviewProject,
            input: sourceOutput,
            outputs: [reviewOutput],
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
              : notificationTopic,
            additionalInformation: `Approve deployment of ${project} to the ${environment} environment`,
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
      artifactBucket,
      stages,
    });
    this.pipeline = pipeline;

    pipeline.notifyOn('FailureNotification', notificationTopic, {
      events: [codepipeline.PipelineNotificationEvents.STAGE_EXECUTION_FAILED],
      notificationRuleName: `${project}-${environment}-pipeline-failure`,
    });

    /* ─── Pipeline trigger (push events) ─────────────────────────────*/
    const triggerRule = new events.Rule(this, 'PipelineTriggerRule', {
      ruleName: `${project}-${environment}-pipeline-trigger`,
      eventPattern: {
        source: ['aws.codecommit'],
        detailType: ['CodeCommit Repository State Change'],
        resources: [repository.repositoryArn],
        detail: {
          event: ['referenceCreated', 'referenceUpdated'],
          referenceType: ['branch'],
          referenceName: [envParams.branchName],
        },
      },
    });
    triggerRule.addTarget(new events_targets.CodePipeline(pipeline));

    /* ─── Effect-measurement dashboard ────────────────────────────────
     * Visualizes the metrics agentic-review.js publishes to metricsNamespace:
     * risk level breakdown, block rate, and Bedrock call reliability /
     * latency / token usage. Without this, "we added an AI review gate" is
     * just an anecdote -- this is what makes it something you can evaluate
     * over time.
     */
    const metricDimensions = { Project: project, Environment: environment };
    const dailyMetric = (metricName: string, dimensions: Record<string, string>, stat: string, label: string) =>
      new cloudwatch.Metric({
        namespace: metricsNamespace,
        metricName,
        dimensionsMap: { ...metricDimensions, ...dimensions },
        statistic: stat,
        period: cdk.Duration.days(1),
        label,
      });

    const dashboard = new cloudwatch.Dashboard(this, 'AgenticReviewDashboard', {
      dashboardName: `${project}-${environment}-agentic-review`,
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Overall risk level (daily count)',
        left: RISK_LEVELS.map((level) => dailyMetric('OverallRiskLevel', { RiskLevel: level }, 'Sum', level)),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Blocked pipeline runs (daily count)',
        left: [dailyMetric('Blocked', {}, 'Sum', 'Blocked runs')],
        width: 12,
      })
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Bedrock call errors per perspective (daily count)',
        left: REVIEW_PERSPECTIVE_IDS.map((p) => dailyMetric('PerspectiveError', { Perspective: p }, 'Sum', p)),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Bedrock call latency per perspective (daily avg ms)',
        left: REVIEW_PERSPECTIVE_IDS.map((p) => dailyMetric('BedrockLatency', { Perspective: p }, 'Average', p)),
        width: 12,
      })
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Bedrock input tokens per perspective (daily sum)',
        left: REVIEW_PERSPECTIVE_IDS.map((p) => dailyMetric('BedrockInputTokens', { Perspective: p }, 'Sum', p)),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Bedrock output tokens per perspective (daily sum)',
        left: REVIEW_PERSPECTIVE_IDS.map((p) => dailyMetric('BedrockOutputTokens', { Perspective: p }, 'Sum', p)),
        width: 12,
      })
    );

    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-S1',
          reason: 'Sample workspace pipeline artifact bucket; server access logging is not required for the demo.',
        },
        {
          id: 'AwsSolutions-CB4',
          reason:
            "Test/Build/AgenticReview/Deploy CodeBuild projects use the default AWS-managed encryption key, matching this repo's other CI/CD reference workspaces.",
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'CDK auto-grants (S3 artifact object access, ECR pull/push, EventBridge PutEvents/StartPipelineExecution) are scoped as narrowly as each API allows. Bedrock foundation-model/inference-profile ARNs are wildcarded because the reviewable model set is intentionally parameterized (BEDROCK_MODEL_ID), not fixed at synth time. CloudWatch PutMetricData has no resource-level ARN and is instead scoped to metricsNamespace via a cloudwatch:namespace condition.',
        },
      ],
      true
    );
  }
}
