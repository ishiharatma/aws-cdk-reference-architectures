import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ApigwLambdaWebAdapterStack } from 'lib/stacks/apigw-lambda-web-adapter-stack';
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

export class ApigwLambdaWebAdapterStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new ApigwLambdaWebAdapterStack(this, `${pascalCase(props.project)}${pascalCase('apigw-lambda-web-adapter')}`, {
      stackName: `${props.project}-${props.environment}-apigw-lambda-web-adapter-stack`,
      description: 'Lambda Web Adapter pattern: API Gateway + Lambda Web Adapter + Express.js',
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    });
  }
}
