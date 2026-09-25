import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { CognitoApigwAuthStack } from 'lib/stacks/cognito-apigw-auth-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

export class CognitoApigwAuthStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new CognitoApigwAuthStack(this, pascalCase(`${props.project}CognitoApigwAuth`), {
      stackName: `${props.project}-${props.environment}-cognito-apigw-auth`,
      description: `${pascalCase(props.project)} Cognito user pool + API Gateway authorization for ${props.environment}`,
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    });
  }
}
