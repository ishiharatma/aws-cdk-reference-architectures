import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { DynamodbVectorSearchSemanticApiStack } from 'lib/stacks/dynamodb-vector-search-semantic-api-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

export class DynamodbVectorSearchSemanticApiStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new DynamodbVectorSearchSemanticApiStack(this, pascalCase(`${props.project}DynamodbVectorSearchSemanticApi`), {
      stackName: `${props.project}-${props.environment}-dynamodb-vector-search-semantic-api`,
      description: `${pascalCase(props.project)} DynamoDB native vector search semantic API for ${props.environment}`,
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    });
  }
}
