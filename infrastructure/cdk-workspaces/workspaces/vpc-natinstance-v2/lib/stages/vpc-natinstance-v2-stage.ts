import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { VpcNatInstanceV2Stack } from "lib/stacks/vpc-natinstance-v2-stack";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";

export interface StageProps extends cdk.StageProps {
  project: string;
  environment: Environment;
  isAutoDeleteObject: boolean;
  terminationProtection: boolean;
}
export class VpcNatInstanceV2Stage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new VpcNatInstanceV2Stack(this, `${pascalCase(props.project)}VpcNatInstanceV2`, {
      description: "VPC NatInstance V2 Stack",
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection, // Enabling deletion protection
      isAutoDeleteObject: props.isAutoDeleteObject,
      isEIPAssociation: false,
    });
  }
}
