import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { EcsBlueGreenNativeVsCodedeployStack } from 'lib/stacks/ecs-blue-green-native-vs-codedeploy-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
  /** Operator IPv4 addresses (bare IP or CIDR) allowed to reach both load balancers. */
  readonly allowedIps: string[];
  readonly allowedIpv6s?: string[];
}

export class EcsBlueGreenNativeVsCodedeployStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new EcsBlueGreenNativeVsCodedeployStack(this, pascalCase(`${props.project}EcsBlueGreenNativeVsCodedeploy`), {
      stackName: `${props.project}-${props.environment}-ecs-blue-green-native-vs-codedeploy`,
      description: `${pascalCase(props.project)} ECS blue/green: native versus CodeDeploy for ${props.environment}`,
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
      allowedIps: props.allowedIps,
      allowedIpv6s: props.allowedIpv6s,
    });
  }
}
