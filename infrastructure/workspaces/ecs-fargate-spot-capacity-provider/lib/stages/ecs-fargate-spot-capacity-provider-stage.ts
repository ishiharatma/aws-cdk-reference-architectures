import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { EcsFargateSpotCapacityProviderStack } from 'lib/stacks/ecs-fargate-spot-capacity-provider-stack';

/** Properties for {@link EcsFargateSpotCapacityProviderStage}. */
export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
  readonly allowedIps: string[];
  readonly allowedIpv6s?: string[];
}

/** Single stack: network, ALB, cluster and the mixed FARGATE / FARGATE_SPOT service. */
export class EcsFargateSpotCapacityProviderStage extends cdk.Stage {
  /** Creates the single stack of this pattern. */
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new EcsFargateSpotCapacityProviderStack(this, pascalCase(`${props.project}EcsFargateSpot`), {
      stackName: `${props.project}-${props.environment}-ecs-fargate-spot`,
      description: 'ECS service mixing FARGATE and FARGATE_SPOT with AZ rebalancing',
      project: props.project,
      environment: props.environment,
      envParams: props.params,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      allowedIps: props.allowedIps,
      allowedIpv6s: props.allowedIpv6s,
    });
  }
}
