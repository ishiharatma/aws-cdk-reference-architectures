import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { LambdaMicrovmsCodexAppserverStack } from 'lib/stacks/lambda-microvms-codex-appserver-stack';
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

export class LambdaMicrovmsCodexAppserverStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new LambdaMicrovmsCodexAppserverStack(this, `${pascalCase(props.project)}${pascalCase('lambda-microvms-codex-appserver')}`, {
      stackName: `${props.project}-${props.environment}-lambda-microvms-codex-appserver-stack`,
      description: 'Serverless Codex App Server on AWS Lambda MicroVMs (VM-isolated codex app-server sessions)',
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    });
  }
}
