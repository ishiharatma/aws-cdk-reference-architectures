import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { VpcCDKDefaultStack } from "lib/stacks/vpc-cdkdefault-stack";
import { VpcBasicsStack } from "lib/stacks/vpc-basics-stack";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";

export interface StageProps extends cdk.StageProps {
  project: string;
  environment: Environment;
  isAutoDeleteObject: boolean;
  terminationProtection: boolean;
}
export class VpcBasicsStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new VpcCDKDefaultStack(this, `${pascalCase(props.project)}VpcCDKDefault`, {
      description: "VPC CDK Default Stack",
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection, // Enabling deletion protection
      isAutoDeleteObject: props.isAutoDeleteObject,
    });

    new VpcBasicsStack(this, `${pascalCase(props.project)}VpcBasics`, {
      description: "VPC Basic Stack",
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection, // Enabling deletion protection
      isAutoDeleteObject: props.isAutoDeleteObject,
    });
  }
}
