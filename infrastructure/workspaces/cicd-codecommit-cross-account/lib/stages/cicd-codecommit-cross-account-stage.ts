import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams, SharedParams } from 'lib/types';
import { PipelineStack } from 'lib/stacks/pipeline-stack';
import { CrossAccountRoleStack } from 'lib/stacks/cross-account-role-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  /** Environment this deployment run targets (dev/stg/prd) — decided by the ENV env var / --context env */
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly sharedParams: SharedParams;
  /** Parameters for every environment (dev/stg/prd) — the pipeline stack needs all three. */
  readonly envParamsMap: Partial<Record<Environment, EnvParams>>;
}

/**
 * Deploying with ENV=dev deploys BOTH stacks below into the dev account:
 * - PipelineStack: CodeCommit + all three pipelines (dev/stg/prd)
 * - CrossAccountRoleStack: the dev account's own (self-trust) deploy role
 *
 * Deploying with ENV=stg or ENV=prd (against that account's own profile)
 * deploys only CrossAccountRoleStack, into that account.
 */
export class CicdCodecommitCrossAccountStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    if (props.environment === Environment.DEVELOPMENT) {
      new PipelineStack(this, pascalCase(`${props.project}Pipeline`), {
        description: `${pascalCase(props.project)} CodeCommit repository + dev/stg/prd pipelines`,
        env: props.env,
        terminationProtection: props.terminationProtection,
        project: props.project,
        isAutoDeleteObject: props.isAutoDeleteObject,
        sharedParams: props.sharedParams,
        envParamsMap: props.envParamsMap,
      });
    }

    const devAccountId = props.sharedParams.codecommitAccountId ?? props.envParamsMap[Environment.DEVELOPMENT]?.accountId;
    if (!devAccountId) {
      throw new Error(
        'CODECOMMIT_ACCOUNT_ID (or DEV_ACCOUNT_ID) must be set — the dev account ID is required to trust its Deploy CodeBuild role.'
      );
    }

    new CrossAccountRoleStack(this, pascalCase(`${props.project}CrossAccountRole${props.environment}`), {
      description: `${pascalCase(props.project)} cross-account deploy role for ${props.environment}`,
      env: props.env,
      terminationProtection: props.terminationProtection,
      project: props.project,
      targetEnv: props.environment,
      devAccountId,
    });
  }
}
