import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Environment } from "@common/parameters/environments";

export interface StackProps extends cdk.StackProps {
  project: string;
  environment: Environment;
  isAutoDeleteObject: boolean;
}

export class VpcCDKDefaultStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Create a VPC with default settings
    this.vpc = new ec2.Vpc(this, "CDKDefault", {});

  }
}
