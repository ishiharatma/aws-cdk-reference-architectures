import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { ApigwVpclinkPrivateAlbStack } from 'lib/stacks/apigw-vpclink-private-alb-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

export class ApigwVpclinkPrivateAlbStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new ApigwVpclinkPrivateAlbStack(this, pascalCase(`${props.project}ApigwVpclinkPrivateAlb`), {
      stackName: `${props.project}-${props.environment}-apigw-vpclink-private-alb`,
      description: `${pascalCase(props.project)} API Gateway REST API to a private ALB (ECS Fargate) over a VPC link for ${props.environment}`,
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    });
  }
}
