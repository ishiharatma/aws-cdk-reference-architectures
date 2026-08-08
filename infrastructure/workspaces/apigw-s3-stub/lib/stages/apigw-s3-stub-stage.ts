import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { EnvParams } from "parameters/environments";
import { ApigwS3StubStack } from 'lib/stacks/apigw-s3-stub-stack';

export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
}

export class ApigwS3StubStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new ApigwS3StubStack(this, pascalCase(`${props.project}ApigwS3Stub`), {
      project: props.project,
      description: `${pascalCase(props.project)} ApigwS3Stub Stack for ${props.environment}`,
      stackName: `${props.project}-${props.environment}-apigw-s3-stub`,
      environment: props.environment,
      envParams: props.params,
      env: props.env,
      terminationProtection: props.terminationProtection, // Enabling deletion protection
      isAutoDeleteObject: props.isAutoDeleteObject,
    });

  }
}
