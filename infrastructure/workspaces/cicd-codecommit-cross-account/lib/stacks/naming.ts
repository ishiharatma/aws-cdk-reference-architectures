import { Environment } from '@common/parameters/environments';

/**
 * Fixed name of a given environment's CodePipeline execution role.
 * Must stay in sync between PipelineStack (which creates the role, in the
 * target account) and RepositoryStack (which trusts it by ARN, in the dev
 * account, for stg/prd's cross-account CodeCommit source access).
 */
export function pipelineRoleName(project: string, env: Environment): string {
  return `${project}-${env}-pipeline-role`;
}

/**
 * Fixed name of the role created in the dev account (by RepositoryStack)
 * that a given target account's pipeline role assumes to read the
 * CodeCommit repository across accounts.
 */
export function sourceActionRoleName(project: string, targetAccountId: string): string {
  return `${project}-pipeline-source-action-${targetAccountId}`;
}
