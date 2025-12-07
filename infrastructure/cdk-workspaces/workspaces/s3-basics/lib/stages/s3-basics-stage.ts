import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { S3BasicStack } from "lib/stacks/s3-basics-stack";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";

export interface StageProps extends cdk.StageProps {
  project: string;
  environment: Environment;
  isAutoDeleteObject: boolean;
  terminationProtection: boolean;
}
export class S3BasicStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new S3BasicStack(this, `${pascalCase(props.project)}S3Basic`, {
      description: "S3 Basic Stack",
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection, // Enabling deletion protection
      isAutoDeleteObject: props.isAutoDeleteObject,
    });
  }
}
