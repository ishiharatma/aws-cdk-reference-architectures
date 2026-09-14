import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams, SharedParams } from 'lib/types';
import { pipelineRoleName, sourceActionRoleName } from 'lib/stacks/naming';

export interface RepositoryStackProps extends cdk.StackProps {
  readonly project: string;
  readonly sharedParams: SharedParams;
  /** Parameters for every environment (dev/stg/prd) — stg/prd need cross-account source access wired up here. */
  readonly envParamsMap: Partial<Record<Environment, EnvParams>>;
}

/**
 * Repository Stack
 *
 * Deployed once, into the dev account only. Creates:
 * - The CodeCommit repository (seeded with the sample app on `main`), plus
 *   `develop`/`staging` branches auto-created from that same initial commit
 * - For every OTHER environment (stg/prd), the plumbing that lets that
 *   environment's own pipeline (deployed by PipelineStack into ITS account)
 *   read this repository across accounts:
 *     1. A fixed-name IAM role here, trusted by that account's pipeline role,
 *        granted CodeCommit read/pull permissions
 *     2. An EventBridge rule forwarding this branch's push events to that
 *        account's default event bus (CodeCommit only publishes events in
 *        the account that owns the repository)
 *
 * The dev environment's own pipeline lives in this same account, so it
 * needs neither of those — see lib/stacks/pipeline-stack.ts.
 */
export class RepositoryStack extends cdk.Stack {
  public readonly repository: codecommit.IRepository;

  constructor(scope: Construct, id: string, props: RepositoryStackProps) {
    super(scope, id, props);

    const region = cdk.Stack.of(this).region;

    /* ─── CodeCommit repository, seeded with the sample app ─────────────*/
    const repository = new codecommit.Repository(this, 'Repository', {
      repositoryName: props.sharedParams.repositoryName,
      description: `${props.project} sample application repository for the cross-account CI/CD demo`,
      code: codecommit.Code.fromDirectory(path.join(__dirname, '../../sample-app'), 'main'),
    });
    this.repository = repository;

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
    // No explicit node.addDependency(repository): the IAM policy above already
    // references repository.repositoryArn, which is enough for CloudFormation
    // to sequence this after the repository exists. A construct-level
    // dependency on `repository` itself would also pull in anything added as
    // a child of it later (e.g. Repository.onCommit()'s EventBridge rule),
    // which can create dependency cycles once that rule targets a pipeline
    // that in turn depends on these branch-creation resources.
    const mainCommitId = getMainBranch.getResponseField('branch.commitId');

    for (const branchName of ['develop', 'staging']) {
      new cr.AwsCustomResource(this, `CreateBranch${pascalCase(branchName)}`, {
        onCreate: {
          service: 'CodeCommit',
          action: 'createBranch',
          parameters: {
            repositoryName: repository.repositoryName,
            branchName,
            // Referencing mainCommitId (a token from GetMainBranch's response)
            // is enough to sequence this after GetMainBranch.
            commitId: mainCommitId,
          },
          physicalResourceId: cr.PhysicalResourceId.of(`CreateBranch-${branchName}`),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [repository.repositoryArn] }),
      });
    }

    /* ─── Cross-account source access for stg/prd's own pipelines ───────*/
    const otherEnvs: Environment[] = [Environment.STAGING, Environment.PRODUCTION];
    for (const targetEnv of otherEnvs) {
      const envParams = props.envParamsMap[targetEnv];
      if (!envParams || !envParams.accountId) {
        continue;
      }
      const targetAccountId = envParams.accountId;

      // 1. Role that targetEnv's pipeline role (in its own account) assumes
      //    to pull from this repository.
      const sourceActionRole = new iam.Role(this, `SourceActionRole${pascalCase(targetEnv)}`, {
        roleName: sourceActionRoleName(props.project, targetAccountId),
        assumedBy: new iam.ArnPrincipal(
          `arn:aws:iam::${targetAccountId}:role/${pipelineRoleName(props.project, targetEnv)}`
        ),
        description: `Assumed by the ${props.project} ${targetEnv} pipeline (account ${targetAccountId}) to read this repository across accounts`,
      });
      sourceActionRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'AllowCodeCommitPull',
          actions: [
            'codecommit:GitPull',
            'codecommit:GetBranch',
            'codecommit:GetCommit',
            'codecommit:GetUploadArchiveStatus',
            'codecommit:UploadArchive',
            'codecommit:CancelUploadArchive',
          ],
          resources: [repository.repositoryArn],
        })
      );

      // 2. Forward this branch's push events to targetEnv's own default event
      //    bus — CodeCommit only emits EventBridge events in the account that
      //    owns the repository, so targetEnv's account can't see them directly.
      const forwardRule = new events.Rule(this, `ForwardBranchEvents${pascalCase(targetEnv)}`, {
        ruleName: `${props.project}-forward-${targetEnv}-branch-events`,
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
      forwardRule.addTarget(
        new events_targets.EventBus(
          events.EventBus.fromEventBusArn(
            this,
            `TargetDefaultBus${pascalCase(targetEnv)}`,
            `arn:aws:events:${region}:${targetAccountId}:event-bus/default`
          )
        )
      );
    }

    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole (used by the CDK-provided AwsCustomResource singleton Lambda for the branch-creation custom resources) is acceptable for this sample.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'The branch-creation custom resource Lambda needs a CloudWatch Logs log-stream wildcard; CodeCommit GetBranch/CreateBranch grants are scoped to this one repository ARN.',
        },
      ],
      true
    );
  }
}
