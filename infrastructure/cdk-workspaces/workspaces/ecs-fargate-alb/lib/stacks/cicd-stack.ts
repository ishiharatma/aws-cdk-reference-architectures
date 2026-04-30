import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { EnvParams } from "parameters/environments";
import { VpcConfig } from '@common/types';


export interface StackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
}
export class CICDStack extends cdk.Stack {

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
  }
}
