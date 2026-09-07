import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ApigwLambdalithStack } from 'lib/stacks/apigw-lambdalith-stack';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

export class ApigwLambdalithStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new ApigwLambdalithStack(this, `${pascalCase(props.project)}${pascalCase('apigw-lambdalith')}`, {
      stackName: `${props.project}-${props.environment}-apigw-lambdalith-stack`,
      description: 'Lambdalith pattern: API Gateway with single Lambda using Hono routing',
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    });
  }
}
