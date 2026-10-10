import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { RdsMultiazVsReadReplicaStack } from 'lib/stacks/rds-multiaz-vs-read-replica-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

export class RdsMultiazVsReadReplicaStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new RdsMultiazVsReadReplicaStack(this, pascalCase(`${props.project}RdsMultiazVsReadReplica`), {
      stackName: `${props.project}-${props.environment}-rds-multiaz-vs-read-replica`,
      description: `${pascalCase(props.project)} RDS Multi-AZ versus read replica for ${props.environment}`,
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    });
  }
}
