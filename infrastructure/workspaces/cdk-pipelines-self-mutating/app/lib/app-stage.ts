import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { HelloStack } from './hello-stack';
import { appStackName, resourcePrefix } from './naming';

export interface AppStageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: string;
  /** Logical stage name shown in the pipeline, e.g. `Dev` / `Prod`. */
  readonly stageName: string;
}

/**
 * A deployable copy of the application. CDK Pipelines deploys one `Stage` per pipeline stage; every
 * stack inside it is deployed with CloudFormation from the pipeline, not from a developer's laptop.
 */
export class AppStage extends cdk.Stage {
  public readonly functionNameOutput: cdk.CfnOutput;
  /** Physical function name; used to scope the smoke test's `lambda:InvokeFunction` permission. */
  public readonly functionName: string;

  constructor(scope: Construct, id: string, props: AppStageProps) {
    super(scope, id, props);

    this.functionName = `${resourcePrefix(props.project, props.environment)}-${props.stageName.toLowerCase()}-hello`;
    const hello = new HelloStack(this, 'Hello', {
      stackName: appStackName(props.project, props.environment, props.stageName),
      description: `Sample application (${props.stageName}) deployed by CDK Pipelines`,
      stageName: props.stageName,
      functionName: this.functionName,
    });
    this.functionNameOutput = hello.functionNameOutput;
  }
}
