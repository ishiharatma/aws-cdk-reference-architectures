import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { APP_VERSION } from './config';

export interface HelloStackProps extends cdk.StackProps {
  /** Stage this copy of the application runs in (e.g. `Dev`, `Prod`). */
  readonly stageName: string;
  readonly functionName: string;
}

/**
 * The "application" the pipeline deploys: one tiny Lambda function that reports which stage and
 * version it is. It exists so a real deployment (and a post-deployment smoke test) has something
 * observable; replace it with your own stacks.
 */
export class HelloStack extends cdk.Stack {
  /** Exposed as a CloudFormation output so the pipeline's smoke test can find the function. */
  public readonly functionNameOutput: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: HelloStackProps) {
    super(scope, id, props);

    const fn = new lambda.Function(this, 'HelloFunction', {
      functionName: props.functionName,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'exports.handler = async () => ({ stage: process.env.STAGE_NAME, version: process.env.APP_VERSION });',
      ),
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: { STAGE_NAME: props.stageName, APP_VERSION },
      logGroup: new logs.LogGroup(this, 'HelloLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    this.functionNameOutput = new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
  }
}
