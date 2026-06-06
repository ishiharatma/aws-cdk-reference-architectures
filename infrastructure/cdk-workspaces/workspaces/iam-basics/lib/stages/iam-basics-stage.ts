import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { IamBasicsStack } from "lib/stacks/iam-basics-stack";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";

export interface StageProps extends cdk.StageProps {
  project: string;
  environment: Environment;
  isAutoDeleteObject: boolean;
  terminationProtection: boolean;
}
export class IamBasicsStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new IamBasicsStack(this, `${pascalCase(props.project)}IamBasics`, {
      description: "IAM Basics Stack",
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection, // Enabling deletion protection
      isAutoDeleteObject: props.isAutoDeleteObject,
    });
  }
}
