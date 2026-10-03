import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { Route53FailoverHealthCheckStack } from 'lib/stacks/route53-failover-health-check-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

export class Route53FailoverHealthCheckStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new Route53FailoverHealthCheckStack(this, pascalCase(`${props.project}Route53FailoverHealthCheck`), {
      stackName: `${props.project}-${props.environment}-route53-failover-health-check`,
      description: `${pascalCase(props.project)} Route53 failover routing with health checks for ${props.environment}`,
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    });
  }
}
