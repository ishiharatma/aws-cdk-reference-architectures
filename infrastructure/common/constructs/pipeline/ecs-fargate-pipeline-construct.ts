/**
 * ECS Fargate Pipeline Construct
 *
 * アプリケーションリポジトリの対象ディレクトリ変更をトリガーとする
 * ECS Fargate アプリの CD パイプライン。ecspresso + jsonnet でデプロイする。
 *
 * ## パイプライン構成
 * ```
 * Stage 1: Source  ← CodeCommit アプリケーションリポジトリ（ブランチはenvに応じて切替）
 * Stage 2: Test    ← CodeBuild: npm ci / lint / test
 * Stage 3: Build   ← CodeBuild: docker build + ECR push
 * Stage 3.5: Approve（requireManualApproval: true の場合のみ）
 * Stage 4: Deploy  ← CodeBuild: ecspresso deploy
 * ```
 *
 * @see {@link https://github.com/kayac/ecspresso} ecspresso
 * @see {@link https://github.com/google/go-jsonnet} go-jsonnet
 */
import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { Environment } from '../../parameters/environments';
import { createPathFilterTrigger, getBranchName } from './pipeline-utils';

/**
 * AppPipelineConstruct プロパティ
 */
export interface AppPipelineConstructProps {
  /** プロジェクト識別子 */
  readonly project: string;
  /** 環境識別子 */
  readonly environment: Environment;
  /**
   * CodeCommit リポジトリが配置されている AWS アカウント ID
   * TODO: 各アカウント ID をプロジェクト担当に確認する
   */
  readonly codecommitAccountId?: string;
  /** CodePipeline 実行ロール（ロール名: <project>-<env>-pipeline-role） */
  readonly pipelineRole: iam.IRole;
  /** パイプライン共有 S3 アーティファクトバケット */
  readonly artifactBucket: s3.IBucket;
  /** パイプライン失敗通知 SNS トピック */
  readonly notificationTopic: sns.ITopic;
  /**
   * ECR リポジトリ（EcsConstruct が作成したもの）
   * コンテナイメージのビルド・プッシュ先として使用する。
   */
  readonly ecrRepository: ecr.IRepository;
  /** ECS Fargateアプリケーションパラメータ（ECS CPU/メモリ/タスク数を Build/Deploy に渡す） */
  readonly params: ApiRelayParams;
  /**
   * Deploy ステージ直前に手動承認ステージを挿入するか
   * prod 環境では true を推奨する。
   * @default false
   */
  readonly requireManualApproval?: boolean;
  /** CloudWatch Logs 保持期間（CodeBuild ログ） */
  readonly logRetentionDays?: logs.RetentionDays;
}

/**
 * App Pipeline Construct
 * ECS Fargate 業務アプリ CD パイプラインを管理する。
 */
export class AppPipelineConstruct extends Construct {
  /** アプリ CD パイプライン */
  public readonly pipeline: codepipeline.IPipeline;
  /** テスト CodeBuild プロジェクト */
  public readonly testProject: codebuild.IProject;
  /** ビルド CodeBuild プロジェクト（docker build + ECR push） */
  public readonly buildProject: codebuild.IProject;
  /** デプロイ CodeBuild プロジェクト（ecspresso） */
  public readonly deployProject: codebuild.IProject;

  /**
   * AppPipelineConstruct コンストラクタ
   * @param scope - 親 Construct
   * @param id - Construct ID
   * @param props - プロパティ
   */
  constructor(scope: Construct, id: string, props: AppPipelineConstructProps) {
    super(scope, id);

    const {
      project,
      environment,
      codecommitAccountId,
      pipelineRole,
      artifactBucket,
      notificationTopic,
      ecrRepository,
      params,
      requireManualApproval = false,
      logRetentionDays = logs.RetentionDays.THREE_MONTHS,
    } = props;
    const stack = cdk.Stack.of(this);
    const actualCodecommitAccountId = codecommitAccountId ?? stack.account;
    const isCrossAccount = actualCodecommitAccountId !== stack.account;
    const buildspecBasePath = 'backend-api';

    /* ─── アーティファクト ────────────────────────────────────────────*/
    const sourceOutput = new codepipeline.Artifact('SourceArtifact');
    const buildOutput = new codepipeline.Artifact('BuildArtifact');

    /* ─── CodeCommit リポジトリ参照 ──────────────────────────────────*/
    const appRepo = codecommit.Repository.fromRepositoryArn(
      this,
      'AppRepo',
      `arn:aws:codecommit:${stack.region}:${actualCodecommitAccountId}:${project}-app`
    );

    /* ─── 共通 env 変数 ──────────────────────────────────────────────*/
    const commonEnvVars: Record<string, codebuild.BuildEnvironmentVariable> = {
      PROJECT: { value: project },
      ENV: { value: environment },
    };

    /* ─── CodeBuild: app-test ─────────────────────────────────────────
     * cd backend-api → npm ci → lint → test
     */
    const testLogGroup = new logs.LogGroup(this, 'TestLogGroup', {
      logGroupName: `/${project}/${environment}/codebuild/app-test`,
      retention: logRetentionDays,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const testProject = new codebuild.PipelineProject(this, 'TestProject', {
      projectName: `${project}-${environment}-app-test`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename(`${buildspecBasePath}/buildspec-test.yml`),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        environmentVariables: commonEnvVars,
      },
      logging: { cloudWatch: { logGroup: testLogGroup } },
    });
    this.testProject = testProject;

    /* ─── CodeBuild: app-build ────────────────────────────────────────
     * docker build + ECR push（コミットハッシュ7桁 + latest タグ）
     */
    const buildLogGroup = new logs.LogGroup(this, 'BuildLogGroup', {
      logGroupName: `/${project}/${environment}/codebuild/app-build`,
      retention: logRetentionDays,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: `${project}-${environment}-app-build`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename(`${buildspecBasePath}/buildspec-build.yml`),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        /* Docker デーモンが必要なため privileged モードを有効にする */
        privileged: true,
        environmentVariables: {
          ...commonEnvVars,
          ECR_REPO_URI: { value: ecrRepository.repositoryUri },
        },
      },
      logging: { cloudWatch: { logGroup: buildLogGroup } },
    });
    this.buildProject = buildProject;

    /* ECR プッシュ権限 */
    buildProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowEcrGetAuthorizationToken',
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    );
    buildProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowEcrPush',
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
          'ecr:PutImage',
        ],
        resources: [ecrRepository.repositoryArn],
      })
    );
    NagSuppressions.addResourceSuppressions(
      buildProject,
      [{ id: 'AwsSolutions-IAM5', reason: 'ECR GetAuthorizationToken は * リソースが必須' }],
      true
    );

    /* ─── CodeBuild: app-deploy ───────────────────────────────────────
     * ecspresso + jsonnet を使用して ECS サービスを更新する。
     */
    const deployLogGroup = new logs.LogGroup(this, 'DeployLogGroup', {
      logGroupName: `/${project}/${environment}/codebuild/app-deploy`,
      retention: logRetentionDays,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const deployProject = new codebuild.PipelineProject(this, 'DeployProject', {
      projectName: `${project}-${environment}-app-deploy`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename(
        `${buildspecBasePath}/buildspec-deploy.yml`
      ),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        environmentVariables: {
          ...commonEnvVars,
          /* ecspresso + jsonnet の外部変数: cicd.md「環境別 CodeBuild 環境変数」参照 */
          TASK_CPU: { value: String(params.ecsTaskCpu) },
          TASK_MEMORY: { value: String(params.ecsTaskMemory) },
          DESIRED_COUNT: { value: String(params.ecsMinTaskCount) },
          ENABLE_ECS_EXEC: { value: String(params.enableEcsExec ?? false) },
          ECR_REPO_URI: { value: ecrRepository.repositoryUri },
          ENABLE_ADOT: { value: String(params.enableAdot ?? false) },
          ADOT_VERSION: { value: String(params.adotVersion ?? 'latest') },
        },
      },
      logging: { cloudWatch: { logGroup: deployLogGroup } },
    });
    this.deployProject = deployProject;

    /* ecspresso deploy に必要な IAM 権限 */
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogsCreateLogStream',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          `arn:aws:logs:${stack.region}:${stack.account}:log-group:/${project}/${environment}/*`,
          /* ecspresso verify がコンテナの CloudWatch Logs 設定を確認する際に
           * ECS タスクのロググループ（/ecs/<project>-<environment>-*）へのアクセスが必要 */
          `arn:aws:logs:${stack.region}:${stack.account}:log-group:/ecs/${project}-${environment}-*:*`,
        ],
      })
    );
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSsmRead',
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
        resources: [`arn:aws:ssm:${stack.region}:${stack.account}:parameter/${project}/*`],
      })
    );
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowEcsOperations',
        actions: [
          'ecs:CreateService',
          'ecs:UpdateService',
          'ecs:RegisterTaskDefinition',
          'ecs:DescribeServices',
          'ecs:DescribeServiceDeployments',
          'ecs:DescribeTaskDefinition',
          'ecs:DescribeTaskSets',
          'ecs:ListTaskDefinitions',
        ],
        resources: ['*'],
      })
    );
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowIamPassRole',
        actions: ['iam:PassRole'],
        resources: [`arn:aws:iam::${stack.account}:role/${project}-*`],
      })
    );
    /* ecspresso verify: IAM ロール存在確認 */
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowIamGetRole',
        actions: ['iam:GetRole'],
        resources: [`arn:aws:iam::${stack.account}:role/${project}-*`],
      })
    );
    /* ecspresso verify: CloudWatch Logs 設定確認（テスト用ログストリーム作成） */
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowLogsCreateLogStream',
        actions: ['logs:CreateLogStream'],
        resources: [
          `arn:aws:logs:${stack.region}:${stack.account}:log-group:/ecs/${project}-${environment}-api:log-stream:*`,
        ],
      })
    );
    /* ecspresso verify: ECR イメージ存在確認 */
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowEcrGetAuthorizationToken',
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    );
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowEcrDescribeImages',
        actions: ['ecr:DescribeImages', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
        resources: [ecrRepository.repositoryArn],
      })
    );
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowElbDescribe',
        actions: [
          'elasticloadbalancing:DescribeTargetGroups',
          'elasticloadbalancing:DescribeListeners',
          'elasticloadbalancing:DescribeRules',
          'elasticloadbalancing:DescribeListenerCertificates',
        ],
        resources: ['*'],
      })
    );
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowAutoScalingDescribe',
        actions: ['application-autoscaling:DescribeScalableTargets'],
        resources: ['*'],
      })
    );
    NagSuppressions.addResourceSuppressions(
      deployProject,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'ECS describe / ELB describe / ECR GetAuthorizationToken は * リソースが必須。ECS タスク定義・サービス ARN は deploy 時に決まるため事前指定不可',
        },
      ],
      true
    );

    /* ─── パイプラインステージ組み立て ───────────────────────────────*/
    const stages: codepipeline.StageProps[] = [
      /* Stage 1: Source */
      {
        stageName: 'Source',
        actions: [
          new codepipeline_actions.CodeCommitSourceAction({
            actionName: 'Source',
            repository: appRepo,
            branch: getBranchName(environment),
            output: sourceOutput,
            /* Lambda パス変更検知フィルターが起動するため NONE を使用する。
             * role を明示指定することで CDK クロスアカウントサポートスタック自動生成を抑止する。 */
            trigger: codepipeline_actions.CodeCommitTrigger.NONE,
            role: isCrossAccount
              ? iam.Role.fromRoleArn(
                  this,
                  'SourceActionRole',
                  `arn:aws:iam::${actualCodecommitAccountId}:role/${project}-pipeline-source-action-${stack.account}`
                )
              : undefined,
          }),
        ],
      },
      /* Stage 2: Test */
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
      /* Stage 3: Build（docker build + ECR push） */
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

    /* Stage 3.5: Approve（手動承認が必要な場合のみ挿入） */
    if (requireManualApproval) {
      stages.push({
        stageName: 'Approve',
        actions: [
          new codepipeline_actions.ManualApprovalAction({
            actionName: 'Approve',
            notificationTopic: notificationTopic,
            additionalInformation: `${project}-${environment}-app パイプラインのデプロイを承認してください`,
          }),
        ],
      });
    }

    /* Stage 4: Deploy（ecspresso） */
    stages.push({
      stageName: 'Deploy',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Deploy',
          project: deployProject,
          input: sourceOutput,
          extraInputs: [buildOutput], // ← ecspresso/** と image-tag.txt
        }),
      ],
    });

    /* ─── CodePipeline ───────────────────────────────────────────────*/
    const pipeline = new codepipeline.Pipeline(this, 'Resource', {
      pipelineName: `${project}-${environment}-app-pipeline`,
      role: pipelineRole,
      artifactBucket: artifactBucket,
      stages,
    });
    this.pipeline = pipeline;

    /* ─── パイプライン失敗通知 ────────────────────────────────────────*/
    pipeline.notifyOn('FailureNotification', notificationTopic, {
      events: [codepipeline.PipelineNotificationEvents.STAGE_EXECUTION_FAILED],
      notificationRuleName: `${project}-${environment}-app-pipeline-failure`,
    });

    /* ─── パス変更検知トリガー（Lambda 経由） ─────────────────────────
     * EventBridge → Lambda → CodePipeline:StartPipelineExecution
     * backend-api/ 配下に変更がある場合のみパイプラインを起動する。
     */
    createPathFilterTrigger(this, 'AppPathFilter', {
      ruleName: `${project}-${environment}-app-pipeline-trigger`,
      functionName: `${project}-${environment}-app-path-filter`,
      repository: appRepo,
      pipeline,
      branchName: getBranchName(environment),
      pathPrefixes: C_APP_BACKEND_API_DIRS,
      logRetentionDays,
      crossAccountRoleArn: isCrossAccount
        ? `arn:aws:iam::${actualCodecommitAccountId}:role/${project}-pipeline-source-action-${stack.account}`
        : undefined,
    });
  }
}
