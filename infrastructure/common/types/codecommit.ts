/* eslint-disable @typescript-eslint/no-explicit-any */
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
    /** AWS account ID where the CodeCommit repository lives */
    readonly codecommitAccountId?: string;
    /** Array of CodeCommit repository names */
    readonly repositories?: string[];

    /** Pipeline notification topic ARN */
    readonly notificationTopicArn?: string;
    /** IAM role ARN used for the source action */
    readonly sourceRoleArn?: string;
    /** IAM role name used for pipeline execution */
    readonly pipelineRoleName?: string;
    /** Definition of destinations to forward branch pushes to via EventBridge */
    readonly forwardTargets?: EventForwardTargetAccount[];
}
/**
 * Definition of a destination that branch pushes are forwarded to via EventBridge from the CodeCommit account
 */
export interface EventForwardTargetAccount {
  /**
   * Destination environment identifier.
   * Converted to a branch name via getBranchName() and also used for EventBridge rule naming.
   */
  readonly environment: Environment;
  /** Destination AWS account ID */
  readonly accountId: string;
}

/**
 * Returns the branch name corresponding to an environment identifier
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
 * Creates a path-change-detection trigger (EventBridge → Lambda → CodePipeline).
 *
 * CodeCommit EventBridge events don't include file path information, so a
 * Lambda inspects the changed files via CodeCommit:GetDifferences and only
 * starts the CodePipeline when a change matches one of the pathPrefixes.
 *
 * Works for both same-account and cross-account setups.
 * Callers must set the CodeCommitSourceAction's trigger to NONE.
 *
 * @param scope - Parent Construct
 * @param id - Construct ID prefix (e.g. 'InfraPathFilter')
 * @param props - Configuration
 */
export function createPathFilterTrigger(this: any, 
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
     * The pipeline is started if any changed file matches one of these prefixes.
     */
    readonly pathPrefixes: string[];
    /** Retention period for the Lambda log group */
    readonly logRetentionDays: logs.RetentionDays;
    /**
     * IAM role ARN for cross-account CodeCommit access.
     * Specify this when CodeCommit lives in a different account.
     * The Lambda assumes this role to call GetDifferences/GetFolder.
     * Use the prs-pipeline-source-action-<devAccountId> role that CommitConstruct creates in prod.
     */
    readonly crossAccountRoleArn?: string;
    /**
     * Directory path (relative to the repository root) whose existence is checked at commit time.
     * If set, the pipeline is not started unless this directory exists.
     * Example: "file-transfer/systems/csms"
     */
    readonly systemDirPath?: string;
    readonly logLevel?: lambda.ApplicationLogLevel;
  }
): void {
  const stack = cdk.Stack.of(scope);

  /* ── Lambda log group ───────────────────────────────────────────*/
  const logGroup = new logs.LogGroup(this, `${id}LogGroup`, {
    logGroupName: `/aws/lambda/${props.functionName}`,
    retention: props.logRetentionDays,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  /* ── Path-change-detection Lambda ──────────────────────────────────────────
   * Gets the commit diff via CodeCommit:GetDifferences and starts the
   * pipeline only if a changed file matches pathPrefixes.
   * Source: infra/src/lambda/path-filter/index.py
   */
  const filterFn = new lambda.Function(this, `${id}Fn`, {
    functionName: props.functionName,
    description: `Lambda that triggers ${props.pipeline.pipelineName} when ${props.repository.repositoryName}/${props.branchName} changes`,
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
    /* Cross-account case: assume the role to call CodeCommit.
     * The Lambda never calls GetDifferences directly; it only accesses it via STS AssumeRole. */
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
