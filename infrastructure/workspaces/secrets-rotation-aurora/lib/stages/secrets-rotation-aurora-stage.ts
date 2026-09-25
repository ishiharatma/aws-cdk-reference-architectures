import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { SecretsRotationAuroraStack } from 'lib/stacks/secrets-rotation-aurora-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

export class SecretsRotationAuroraStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new SecretsRotationAuroraStack(this, pascalCase(`${props.project}SecretsRotationAurora`), {
      stackName: `${props.project}-${props.environment}-secrets-rotation-aurora`,
      description: `${pascalCase(props.project)} Aurora with Secrets Manager rotation for ${props.environment}`,
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    });
  }
}
