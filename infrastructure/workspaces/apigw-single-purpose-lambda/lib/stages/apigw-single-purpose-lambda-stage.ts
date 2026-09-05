import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ApigwSinglePurposeLambdaStack } from 'lib/stacks/apigw-single-purpose-lambda-stack';
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

export class ApigwSinglePurposeLambdaStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new ApigwSinglePurposeLambdaStack(this, `${pascalCase(props.project)}${pascalCase('apigw-single-purpose-lambda')}`, {
      stackName: `${props.project}-${props.environment}-apigw-single-purpose-lambda-stack`,
      description: 'Single-Purpose Lambda pattern: API Gateway with individual Lambda per endpoint',
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    });
  }
}
