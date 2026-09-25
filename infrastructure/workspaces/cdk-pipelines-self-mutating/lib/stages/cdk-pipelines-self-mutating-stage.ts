import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { RepositoryStack } from 'lib/stacks/repository-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

export class CdkPipelinesSelfMutatingStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new RepositoryStack(this, pascalCase(`${props.project}CdkPipelinesRepository`), {
      stackName: `${props.project}-${props.environment}-cdkp-repository`,
      description: `${pascalCase(props.project)} CodeCommit repository seeded with the CDK Pipelines app (${props.environment})`,
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    });
  }
}
