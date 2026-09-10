import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';

export interface CrossAccountRoleStackProps extends cdk.StackProps {
  readonly project: string;
  /** Which pipeline environment (dev/stg/prd) this account corresponds to. */
  readonly targetEnv: Environment;
  /**
   * AWS account ID where CodeCommit and every pipeline live (the dev account).
   * The trust policy below only allows that account's fixed-name Deploy
   * CodeBuild role — see lib/stacks/pipeline-stack.ts — to assume this role.
   */
  readonly devAccountId: string;
}

/**
 * Cross-Account Deploy Role Stack
 *
 * Deployed once into EACH target account (dev/stg/prd). Creates the IAM role
 * that the dev account's Deploy CodeBuild project (for this same targetEnv)
 * assumes via `sts:AssumeRole` to perform the actual deployment.
 *
 * For the dev environment this is a same-account (self-trust) role; for
 * stg/prd it is the cross-account hop. Both are created the same way so the
 * Deploy buildspec doesn't need to special-case same-account vs cross-account.
 */
export class CrossAccountRoleStack extends cdk.Stack {
  public readonly role: iam.IRole;

  constructor(scope: Construct, id: string, props: CrossAccountRoleStackProps) {
    super(scope, id, props);

    const deployBuildRoleName = `${props.project}-${props.targetEnv}-deploy-build-role`;
    const trustedRoleArn = `arn:aws:iam::${props.devAccountId}:role/${deployBuildRoleName}`;

    const role = new iam.Role(this, 'CrossAccountDeployRole', {
      roleName: `${props.project}-${props.targetEnv}-cross-account-deploy-role`,
      assumedBy: new iam.ArnPrincipal(trustedRoleArn),
      description: `Assumed by the ${props.project} CI/CD pipeline's Deploy CodeBuild project (account ${props.devAccountId}) to deploy into the ${props.targetEnv} account`,
      maxSessionDuration: cdk.Duration.hours(1),
    });
    this.role = role;

    // Minimal sample permission set for the "echo + get-caller-identity" sample
    // buildspec. Replace with whatever the real deployment needs
    // (cdk deploy, aws s3 sync, ecs update-service, ...).
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowSampleReadOnly',
        actions: ['s3:ListAllMyBuckets'],
        resources: ['*'],
      })
    );

    NagSuppressions.addResourceSuppressions(
      role,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            's3:ListAllMyBuckets does not support resource-level scoping; this is a sample deploy role meant to be replaced with real, resource-scoped deployment permissions.',
        },
      ],
      true
    );

    new cdk.CfnOutput(this, 'CrossAccountDeployRoleArn', {
      value: this.role.roleArn,
      description: `IAM role the dev account's ${props.targetEnv} Deploy CodeBuild project assumes to deploy here`,
    });
  }
}
