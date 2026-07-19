import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { SqsLambdaFirehoseStack } from "lib/stacks/sqs-lambda-firehose-stack";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { EnvParams } from 'parameters/environments';

export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
}

/**
 * SQS Lambda Firehose Stage
 * 
 */
export class SqsLambdaFirehoseStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    // SQS Lambda Firehose Stack
    new SqsLambdaFirehoseStack(this, `${pascalCase(props.project)}${pascalCase('sqs-lambda-firehose')}`, {
        stackName: `${props.project}-${props.environment}-sqs-lambda-firehose-stack`,
        description : 'Stack deploying SQS to Lambda to Firehose integration',
        project: props.project,
        environment: props.environment,
        env: props.env,
        terminationProtection: props.terminationProtection,
        isAutoDeleteObject:  props.isAutoDeleteObject,
        params: props.params,
    });

  }
}

