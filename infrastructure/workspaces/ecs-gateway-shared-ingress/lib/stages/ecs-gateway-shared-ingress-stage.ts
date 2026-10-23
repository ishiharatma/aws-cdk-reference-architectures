import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { PlatformStack } from 'lib/stacks/platform-stack';
import { AppStack } from 'lib/stacks/app-stack';

/** Properties for {@link EcsGatewaySharedIngressStage}. */
export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
  readonly allowedIps: string[];
}

/** Platform stack (gateways, cluster) and application stack (services that opt in). */
export class EcsGatewaySharedIngressStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    const platform = new PlatformStack(this, pascalCase(`${props.project}EcsGatewayPlatform`), {
      stackName: `${props.project}-${props.environment}-ecs-gateway-platform`,
      description: 'ECS Gateway shared ingress: VPC, cluster, internet-facing and internal gateways (platform team)',
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params.platform,
      allowedIps: props.allowedIps,
    });

    const app = new AppStack(this, pascalCase(`${props.project}EcsGatewayApp`), {
      stackName: `${props.project}-${props.environment}-ecs-gateway-app`,
      description: 'ECS Gateway shared ingress: Fargate services with gateway connectors (application team)',
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params.app,
      vpc: platform.vpc,
      cluster: platform.cluster,
      testTrafficHeader: props.params.platform.testTrafficHeader,
    });
    // A connector is rejected unless an ACTIVE association exists, and on destroy the services must
    // go first: an association stays DISASSOCIATING until every gateway route on the cluster is removed.
    app.addStackDependency(platform, 'Services need ACTIVE gateway cluster associations');
  }
}
