/* eslint-disable cdk/require-passing-this */
/**
 * Common utilities for Pipeline Constructs
 */
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { Environment } from '../../parameters/environments';

/**
 * Returns the branch name corresponding to the environment identifier
 * @param environment - Environment identifier
 * @returns Branch name
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
 * Creates a path-change detection trigger (EventBridge → Lambda → CodePipeline).
 *
 * CodeCommit EventBridge events don't include file path information, so the
 * Lambda inspects the changed files via CodeCommit:GetDifferences and only
 * starts the CodePipeline when a change matches one of the pathPrefixes.
 *
 * Works for both same-account and cross-account setups.
 * Callers must set the CodeCommitSourceAction trigger to NONE.
 *
 * @param scope - Parent Construct
 * @param id - Construct ID prefix (e.g. 'InfraPathFilter')
 * @param props - Configuration
 */
export function createPathFilterTrigger(
  scope: Construct,
  id: string,
  props: {
    /** EventBridge rule name */
    readonly ruleName: string;
    /** Lambda function name */
    readonly functionName: string;
    /** CodeCommit repository to trigger on */
    readonly repository: codecommit.IRepository;
    /** Pipeline to start */
    readonly pipeline: codepipeline.IPipeline;
    /** Branch name to trigger on */
    readonly branchName: string;
    /**
     * List of path prefixes to detect changes for.
     * The pipeline is started when a changed file matches any of these prefixes.
     */
    readonly pathPrefixes: string[];
    /** Retention period for the Lambda log group */
    readonly logRetentionDays: logs.RetentionDays;
    /**
     * IAM role ARN for cross-account CodeCommit access.
     * Specify this when CodeCommit is in a different account.
     * The Lambda assumes this role to call GetDifferences/GetFolder.
     * Specify the prs-pipeline-source-action-<devAccountId> role that
     * CommitConstruct creates in prod.
     */
    readonly crossAccountRoleArn?: string;
    /**
     * Directory path (relative to the repository root) whose existence is
     * checked at the commit in question.
     * If set, the pipeline is not started when the directory doesn't exist.
     * Example: "file-transfer/systems/csms"
     */
    readonly systemDirPath?: string;
    readonly logLevel?: lambda.ApplicationLogLevel;
  }
): void {
  const stack = cdk.Stack.of(scope);

  /* ── Lambda log group ───────────────────────────────────────────*/
  const logGroup = new logs.LogGroup(scope, `${id}LogGroup`, {
    logGroupName: `/aws/lambda/${props.functionName}`,
    retention: props.logRetentionDays,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  /* ── Path-change detection Lambda ──────────────────────────────────────────
   * Retrieves the commit diff via CodeCommit:GetDifferences and only starts
   * the pipeline when a file matching pathPrefixes is included.
   * Source: infra/src/lambda/path-filter/index.py
   */
  const filterFn = new lambda.Function(scope, `${id}Fn`, {
    functionName: props.functionName,
    description: `Lambda that triggers ${props.pipeline.pipelineName} when ${props.repository.repositoryName}/${props.branchName} changes`,
    runtime: lambda.Runtime.PYTHON_3_13,
    handler: 'index.handler',
    code: lambda.Code.fromAsset(path.join(__dirname, '../../src/python-lambda/path-filter')),
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
    /* Cross-account case: assume the role to call CodeCommit.
     * The Lambda never calls GetDifferences directly; it only accesses
     * CodeCommit via STS AssumeRole. */
    filterFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowAssumeCodeCommitRole',
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: [props.crossAccountRoleArn],
      })
    );
  } else {
    /* Same-account case: call GetDifferences/GetFolder directly. */
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

  /* ── EventBridge trigger rule ───────────────────────────────────*/
  const rule = new events.Rule(scope, `${id}TriggerRule`, {
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
