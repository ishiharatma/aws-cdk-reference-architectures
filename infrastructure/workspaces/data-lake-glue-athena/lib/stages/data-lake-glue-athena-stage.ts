import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { DataLakeGlueAthenaStack } from 'lib/stacks/data-lake-glue-athena-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

export class DataLakeGlueAthenaStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new DataLakeGlueAthenaStack(this, pascalCase(`${props.project}DataLakeGlueAthena`), {
      stackName: `${props.project}-${props.environment}-data-lake-glue-athena`,
      description: `${pascalCase(props.project)} data lake with Glue and Athena for ${props.environment}`,
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    });
  }
}
