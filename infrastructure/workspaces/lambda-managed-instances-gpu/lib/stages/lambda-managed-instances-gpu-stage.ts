import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { LambdaManagedInstancesGpuStack } from 'lib/stacks/lambda-managed-instances-gpu-stack';

/** Properties for {@link LambdaManagedInstancesGpuStage}. */
export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

/** Deploys the GPU inference stack. */
export class LambdaManagedInstancesGpuStage extends cdk.Stage {
  /** Creates the stage and its single stack. */
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new LambdaManagedInstancesGpuStack(this, pascalCase(`${props.project}LambdaManagedInstancesGpu`), {
      stackName: `${props.project}-${props.environment}-lambda-managed-instances-gpu`,
      description: 'Lambda Managed Instances GPU pattern: S3 -> SQS -> GPU Event Function -> DynamoDB',
      project: props.project,
      environment: props.environment,
      params: props.params,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
    });
  }
}
