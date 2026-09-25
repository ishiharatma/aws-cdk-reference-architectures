import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { EventbridgeCustomBusStack } from 'lib/stacks/eventbridge-custom-bus-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

export class EventbridgeCustomBusStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new EventbridgeCustomBusStack(this, pascalCase(`${props.project}EventbridgeCustomBus`), {
      stackName: `${props.project}-${props.environment}-eventbridge-custom-bus`,
      description: `${pascalCase(props.project)} EventBridge custom bus routing for ${props.environment}`,
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    });
  }
}
