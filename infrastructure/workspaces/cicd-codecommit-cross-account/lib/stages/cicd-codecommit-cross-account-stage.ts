import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams, SharedParams } from 'lib/types';
import { RepositoryStack } from 'lib/stacks/repository-stack';
import { PipelineStack } from 'lib/stacks/pipeline-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  /** Environment this deployment run targets (dev/stg/prd) — decided by the ENV env var / --context env */
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly sharedParams: SharedParams;
  /** Parameters for every environment (dev/stg/prd) — RepositoryStack needs all three. */
  readonly envParamsMap: Partial<Record<Environment, EnvParams>>;
}

/**
 * Deploying with ENV=dev, against the dev account's own profile, deploys
 * BOTH stacks below into the dev account:
 * - RepositoryStack: the CodeCommit repository, its branches, and the
 *   cross-account plumbing (roles + event forwarding) for stg/prd
 * - PipelineStack: the dev environment's own pipeline (same-account source)
 *
 * Deploying with ENV=stg or ENV=prd, against THAT account's own profile,
 * deploys only PipelineStack, into that account — its Source stage reads
 * the dev account's CodeCommit repository across accounts.
 */
export class CicdCodecommitCrossAccountStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    const envParams = props.envParamsMap[props.environment];
    if (!envParams) {
      throw new Error(`No parameters found for environment: ${props.environment}`);
    }

    const pipelineStack = new PipelineStack(this, pascalCase(`${props.project}Pipeline`), {
      description: `${pascalCase(props.project)} ${props.environment} pipeline`,
      env: props.env,
      terminationProtection: props.terminationProtection,
      project: props.project,
      environment: props.environment,
      isAutoDeleteObject: props.isAutoDeleteObject,
      sharedParams: props.sharedParams,
      envParams,
    });

    if (props.environment === Environment.DEVELOPMENT) {
      const repositoryStack = new RepositoryStack(this, pascalCase(`${props.project}Repository`), {
        description: `${pascalCase(props.project)} CodeCommit repository + cross-account source access for stg/prd`,
        env: props.env,
        terminationProtection: props.terminationProtection,
        project: props.project,
        sharedParams: props.sharedParams,
        envParamsMap: props.envParamsMap,
      });
      // The dev pipeline references the repository by name (same account) —
      // it must exist before the pipeline (and its EventBridge trigger rule,
      // which filters on the repository's ARN) is deployed.
      pipelineStack.addStackDependency(repositoryStack);
    }
  }
}
