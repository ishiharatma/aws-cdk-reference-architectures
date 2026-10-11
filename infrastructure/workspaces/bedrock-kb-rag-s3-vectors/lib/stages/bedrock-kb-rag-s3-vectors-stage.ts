import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { BedrockKbRagS3VectorsStack } from 'lib/stacks/bedrock-kb-rag-s3-vectors-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

export class BedrockKbRagS3VectorsStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new BedrockKbRagS3VectorsStack(this, pascalCase(`${props.project}BedrockKbRagS3Vectors`), {
      stackName: `${props.project}-${props.environment}-bedrock-kb-rag-s3-vectors`,
      description: `${pascalCase(props.project)} Bedrock Knowledge Base RAG on S3 Vectors for ${props.environment}`,
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    });
  }
}
