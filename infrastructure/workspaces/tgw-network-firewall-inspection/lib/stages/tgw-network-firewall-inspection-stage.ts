import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { TgwNetworkFirewallInspectionStack } from 'lib/stacks/tgw-network-firewall-inspection-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

export class TgwNetworkFirewallInspectionStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new TgwNetworkFirewallInspectionStack(this, pascalCase(`${props.project}TgwNetworkFirewallInspection`), {
      stackName: `${props.project}-${props.environment}-tgw-network-firewall-inspection`,
      description: `${pascalCase(props.project)} Transit Gateway centralized inspection with AWS Network Firewall for ${props.environment}`,
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    });
  }
}
