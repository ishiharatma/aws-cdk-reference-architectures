import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { EnvParams } from "parameters/environments";
import { CicdCloudfrontS3Stack } from 'lib/stacks/cicd-cloudfront-s3-stack';

export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
}

export class CicdCloudfrontS3Stage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new CicdCloudfrontS3Stack(this, pascalCase(`${props.project}CicdCloudfrontS3`), {
      project: props.project,
      description: `${pascalCase(props.project)} CicdCloudfrontS3 Stack for ${props.environment}`,
      environment: props.environment,
      envParams: props.params,
      env: props.env,
      terminationProtection: props.terminationProtection, // Enabling deletion protection
      isAutoDeleteObject: props.isAutoDeleteObject,
    });

  }
}
