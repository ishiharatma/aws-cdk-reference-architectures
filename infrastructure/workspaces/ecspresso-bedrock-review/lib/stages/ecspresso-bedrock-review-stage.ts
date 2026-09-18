import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams, SharedParams } from 'lib/types';
import { RepositoryStack } from 'lib/stacks/repository-stack';
import { PipelineStack } from 'lib/stacks/pipeline-stack';

/** EcspressoBedrockReviewStage properties. */
export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly sharedParams: SharedParams;
  readonly params: EnvParams;
}

/** Deploys RepositoryStack (CodeCommit) and PipelineStack (CodePipeline) together for one environment. */
export class EcspressoBedrockReviewStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    const repositoryStack = new RepositoryStack(this, pascalCase(`${props.project}Repository`), {
      description: `${pascalCase(props.project)} CodeCommit repository (seeded with the ecspresso-bedrock-review-app sample)`,
      env: props.env,
      terminationProtection: props.terminationProtection,
      project: props.project,
      sharedParams: props.sharedParams,
      envParams: props.params,
    });

    const pipelineStack = new PipelineStack(this, pascalCase(`${props.project}Pipeline`), {
      description: `${pascalCase(props.project)} ${props.environment} pipeline (Test/Build/AgenticReview/Deploy)`,
      env: props.env,
      terminationProtection: props.terminationProtection,
      project: props.project,
      environment: props.environment,
      isAutoDeleteObject: props.isAutoDeleteObject,
      sharedParams: props.sharedParams,
      envParams: props.params,
      repository: repositoryStack.repository,
    });
    pipelineStack.addStackDependency(repositoryStack);
  }
}
