import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { EnvParams } from "parameters/environments";
import * as path from 'path';
import { SnsBasicStack } from 'lib/stacks/sns-basic-stack';

export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
}

export class SnsBasicStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new SnsBasicStack(this, pascalCase(`${props.project}SnsBasic`), {
      project: props.project,
      stackName: `${props.project}-${props.environment}-sns-basic`,
      description: `${pascalCase(props.project)} SnsBasic Stack for ${props.environment}`,
      environment: props.environment,
      params: props.params,
      env: props.env,
      terminationProtection: props.terminationProtection, // Enabling deletion protection
      isAutoDeleteObject: props.isAutoDeleteObject,
    });

  }
}
