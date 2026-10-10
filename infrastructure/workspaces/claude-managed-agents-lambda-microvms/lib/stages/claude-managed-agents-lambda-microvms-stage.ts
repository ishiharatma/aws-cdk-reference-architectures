import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { ClaudeManagedAgentsLambdaMicrovmsStack } from 'lib/stacks/claude-managed-agents-lambda-microvms-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

export class ClaudeManagedAgentsLambdaMicrovmsStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new ClaudeManagedAgentsLambdaMicrovmsStack(this, 'Main', {
      project: props.project,
      environment: props.environment,
      envParams: props.params,
      env: props.env,
      stackName: `${props.project}-${props.environment}-claude-managed-agents`,
      description: `Claude Managed Agents self-hosted sandboxes on Lambda MicroVMs (${props.environment})`,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
    });
  }
}
