 
import { Construct } from 'constructs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';

import { Environment } from "../parameters/environments";
/**
 *
 */
export interface CodeCommitConfig {
    /** CodeCommit リポジトリが存在する AWS アカウント ID */
    readonly codecommitAccountId: string;
    /** CodeCommit リポジトリ名の配列 */
    readonly repositories: string[];

    /** パイプライン通知トピック ARN */
    readonly notificationTopicArn?: string;
    /** ソースアクションに使用する IAM ロール ARN */
    readonly sourceRoleArn?: string;
    /** パイプライン実行に使用する IAM ロール名 */
    readonly pipelineRoleName?: string;
    /** EventBridge でブランチプッシュを転送する先の定義 */
    readonly forwardTargets?: EventForwardTargetAccount[];
}
/**
 * CodeCommit アカウントから EventBridge でブランチプッシュを転送する先の定義
 */
export interface EventForwardTargetAccount {
  /**
   * 転送先環境識別子
   * getBranchName() でブランチ名に変換し、EventBridge ルール命名にも使用する。
   */
  readonly environment: Environment;
  /** 転送先 AWS アカウント ID */
  readonly accountId: string;
}

/**
 * 環境識別子に対応するブランチ名を返す
 * @param environment - 環境識別子
 * @returns ブランチ名
 */
export function getBranchName(environment: Environment): string {
  switch (environment) {
    case Environment.DEVELOPMENT:
      return 'develop';
    case Environment.STAGING:
      return 'staging';
    case Environment.PRODUCTION:
      return 'main';
    default:
      return 'develop';
  }
}

/**
 * パス変更検知トリガーを作成する（EventBridge → Lambda → CodePipeline）。
 *
 * CodeCommit の EventBridge イベントにはファイルパス情報が含まれないため、
 * Lambda が CodeCommit:GetDifferences で変更ファイルを検査し、
 * pathPrefixes に一致する変更があった場合のみ CodePipeline を起動する。
 *
 * 同一アカウント・クロスアカウントのどちらでも使用できる。
 * 呼び出し元では CodeCommitSourceAction の trigger を NONE に設定すること。
 *
 * @param scope - 親 Construct
 * @param id - Construct ID プレフィックス（例: 'InfraPathFilter'）
 * @param props - 設定
 */
export function createPathFilterTrigger(
  scope: Construct,
  id: string,
  props: {
    /** EventBridge ルール名 */
    readonly ruleName: string;
    /** Lambda 関数名 */
    readonly functionName: string;
    /** トリガー対象 CodeCommit リポジトリ */
    readonly repository: codecommit.IRepository;
    /** 起動するパイプライン */
    readonly pipeline: codepipeline.IPipeline;
    /** トリガーするブランチ名 */
    readonly branchName: string;
    /**
     * 変更検知するパスプレフィックス一覧
     * いずれかのプレフィックスに一致するファイルが変更された場合にパイプラインを起動する。
     */
    readonly pathPrefixes: string[];
    /** Lambda ロググループの保持期間 */
    readonly logRetentionDays: logs.RetentionDays;
    /**
     * クロスアカウント CodeCommit アクセス用 IAM ロール ARN。
     * CodeCommit が別アカウントにある場合に指定する。
     * Lambda はこのロールを Assume して GetDifferences/GetFolder を呼び出す。
     * CommitConstruct が prod に作成する prs-pipeline-source-action-<devAccountId> ロールを指定すること。
     */
    readonly crossAccountRoleArn?: string;
    /**
     * コミット時点での存在チェックを行うディレクトリパス（リポジトリルートからの相対パス）。
     * 設定した場合、そのディレクトリが存在しなければパイプラインを起動しない。
     * 例: "file-transfer/systems/csms"
     */
    readonly systemDirPath?: string;
    readonly logLevel?: lambda.ApplicationLogLevel;
  }
): void {
  const stack = cdk.Stack.of(scope);

  /* ── Lambda ロググループ ───────────────────────────────────────────*/
  const logGroup = new logs.LogGroup(this, `${id}LogGroup`, {
    logGroupName: `/aws/lambda/${props.functionName}`,
    retention: props.logRetentionDays,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  /* ── パス変更検知 Lambda ──────────────────────────────────────────
   * CodeCommit:GetDifferences でコミット差分を取得し、
   * pathPrefixes に一致するファイルが含まれる場合のみパイプラインを起動する。
   * ソース: infra/src/lambda/path-filter/index.py
   */
  const filterFn = new lambda.Function(this, `${id}Fn`, {
    functionName: props.functionName,
    description: `${props.repository.repositoryName}/${props.branchName}が変更された場合に ${props.pipeline.pipelineName} をトリガーする Lambda`,
    runtime: lambda.Runtime.PYTHON_3_13,
    handler: 'index.handler',
    code: lambda.Code.fromAsset(path.join(__dirname, '../../../src/lambda/path-filter')),
    environment: {
      PIPELINE_NAME: props.pipeline.pipelineName,
      PATH_PREFIXES: props.pathPrefixes.join(','),
      ...(props.systemDirPath ? { SYSTEM_DIR_PATH: props.systemDirPath } : {}),
      ...(props.crossAccountRoleArn ? { CODECOMMIT_ROLE_ARN: props.crossAccountRoleArn } : {}),
    },
    timeout: cdk.Duration.seconds(30),
    loggingFormat: lambda.LoggingFormat.JSON,
    applicationLogLevelV2: props.logLevel ?? lambda.ApplicationLogLevel.INFO,
    logGroup,
  });

  if (props.crossAccountRoleArn) {
    /* クロスアカウントの場合: ロールを Assume して CodeCommit を呼び出す。
     * Lambda 自身は GetDifferences を直接呼ばず、STS AssumeRole 経由でのみアクセスする。 */
    filterFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowAssumeCodeCommitRole',
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: [props.crossAccountRoleArn],
      })
    );
  } else {
    /* 同一アカウントの場合: 直接 GetDifferences/GetFolder を呼び出す。 */
    filterFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCodeCommitDiff',
        effect: iam.Effect.ALLOW,
        actions: ['codecommit:GetDifferences', 'codecommit:GetFolder'],
        resources: [props.repository.repositoryArn],
      })
    );
  }

  filterFn.addToRolePolicy(
    new iam.PolicyStatement({
      sid: 'AllowStartPipeline',
      effect: iam.Effect.ALLOW,
      actions: ['codepipeline:StartPipelineExecution'],
      resources: [
        `arn:aws:codepipeline:${stack.region}:${stack.account}:${props.pipeline.pipelineName}`,
      ],
    })
  );

  NagSuppressions.addResourceSuppressions(
    filterFn,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is acceptable for pipeline path filter Lambda',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CloudWatch Logs wildcard is required for Lambda log stream creation',
      },
    ],
    true
  );

  /* ── EventBridge トリガールール ───────────────────────────────────*/
  const rule = new events.Rule(this, `${id}TriggerRule`, {
    ruleName: props.ruleName,
    eventPattern: {
      source: ['aws.codecommit'],
      detailType: ['CodeCommit Repository State Change'],
      resources: [props.repository.repositoryArn],
      detail: {
        event: ['referenceCreated', 'referenceUpdated'],
        referenceType: ['branch'],
        referenceName: [props.branchName],
      },
    },
  });
  rule.addTarget(new events_targets.LambdaFunction(filterFn));
}
