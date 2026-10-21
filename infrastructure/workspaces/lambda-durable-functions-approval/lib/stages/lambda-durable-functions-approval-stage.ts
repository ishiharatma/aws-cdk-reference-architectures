import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { LambdaDurableFunctionsApprovalStack } from 'lib/stacks/lambda-durable-functions-approval-stack';

/** Properties for {@link LambdaDurableFunctionsApprovalStage}. */
export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

/** Deploys the approval workflow stack. */
export class LambdaDurableFunctionsApprovalStage extends cdk.Stage {
  /** Creates the stage and its single stack. */
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new LambdaDurableFunctionsApprovalStack(
      this,
      pascalCase(`${props.project}LambdaDurableFunctionsApproval`),
      {
        stackName: `${props.project}-${props.environment}-lambda-durable-functions-approval`,
        description:
          'Lambda durable functions pattern: human-in-the-loop approval workflow (API Gateway + DynamoDB + SNS)',
        project: props.project,
        environment: props.environment,
        env: props.env,
        terminationProtection: props.terminationProtection,
        isAutoDeleteObject: props.isAutoDeleteObject,
        params: props.params,
      }
    );
  }
}
