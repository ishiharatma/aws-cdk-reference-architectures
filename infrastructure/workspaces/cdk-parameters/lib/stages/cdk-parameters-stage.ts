import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { CdkTSParametersStack } from "lib/stacks/cdk-ts-parameters-stack";
import { CdkJsonParametersStack } from "lib/stacks/cdk-json-parameters-stack";
import { pascalCase } from "change-case-commonjs";
import { Environment } from 'lib/types/common';
import { EnvParams } from 'parameters/environments';

export interface StageProps extends cdk.StageProps {
  project: string;
  environment: Environment;
  isAutoDeleteObject: boolean;
  terminationProtection: boolean;
  params: EnvParams;
}

export interface StageProps extends cdk.StageProps {
  project: string;
  environment: Environment;
  isAutoDeleteObject: boolean;
  terminationProtection: boolean;
}
export class CdkParametersStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);
    new CdkTSParametersStack(this, `${pascalCase(props.project)}TSParameters`, {
      description: "Typescript Parameters Stack",
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection, // Enabling deletion protection
      isAutoDeleteObject: props.isAutoDeleteObject,
      vpcConfig: props.params.vpcConfig
    });

    new CdkJsonParametersStack(this, `${pascalCase(props.project)}CdkJsonParameters`, {
      description: "CDK JSON Parameters Stack",
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection, // Enabling deletion protection
      isAutoDeleteObject: props.isAutoDeleteObject,
    });
  }
}
