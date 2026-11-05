import * as iam from 'aws-cdk-lib/aws-iam';
import { Stack } from 'aws-cdk-lib';
import { CodeCommitParams } from 'parameters/environments';

/** Every repository a session may reach: the existing ones and the ones this application creates. */
export function accessibleRepositoryNames(params?: CodeCommitParams): string[] {
  return [...(params?.repositoryNames ?? []), ...(params?.managedRepositoryNames ?? [])];
}

/**
 * Clone and push on the named repositories only. The role is shared by all sessions of this
 * deployment, so every user can reach every repository listed here.
 */
export function codeCommitPolicy(stack: Stack, repositoryNames: string[]): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'CodeCommitGitAccess',
    actions: ['codecommit:GitPull', 'codecommit:GitPush'],
    resources: repositoryNames.map((name) => stack.formatArn({ service: 'codecommit', resource: name })),
  });
}
