import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { Ec2DualEniStack } from 'lib/stacks/ec2-dual-eni-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
  /** CIDRs allowed to SSH to the management ENI. Overrides params.managementAllowedCidrs. */
  readonly managementAllowedCidrs?: string[];
  /** CIDRs allowed to reach the web server (HTTP/HTTPS on eth0). */
  readonly webAllowedCidrs: string[];
}

export class Ec2DualEniStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new Ec2DualEniStack(this, `${pascalCase(props.project)}Ec2DualEni`, {
      project: props.project,
      environment: props.environment,
      description: `EC2 Dual ENI — ${props.environment}`,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      envParams: props.params,
      managementAllowedCidrs: props.managementAllowedCidrs,
      webAllowedCidrs: props.webAllowedCidrs,
    });
  }
}
