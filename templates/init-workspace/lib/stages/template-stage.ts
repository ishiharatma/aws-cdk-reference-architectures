import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { EnvParams } from "parameters/environments";
import * as path from 'path';
import { TemplateStack } from 'lib/stacks/template-stack';

export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
}

export class TemplateStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new TemplateStack(this, pascalCase(`${props.project}Template`), {
      project: props.project,
      description: `${pascalCase(props.project)} Template Stack for ${props.environment}`,
      environment: props.environment,
      envParams: props.params,
      env: props.env,
      terminationProtection: props.terminationProtection, // Enabling deletion protection
      isAutoDeleteObject: props.isAutoDeleteObject,
    });

  }
}
