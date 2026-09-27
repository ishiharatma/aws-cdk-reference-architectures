import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { AwsEolMonitorDataStack } from 'lib/stacks/aws-eol-monitor-data-stack';
import { AwsEolMonitorApplicationStack } from 'lib/stacks/aws-eol-monitor-application-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

/**
 * AWS Service EOL Monitor Stage
 *
 * Data (stateful, DynamoDB state table) -> Application (stateless, the
 * Lambda + Step Functions + EventBridge Scheduler + SNS pipeline).
 */
export class AwsEolMonitorStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    const commonStackProps = {
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
    };

    const dataStack = new AwsEolMonitorDataStack(this, `${pascalCase(props.project)}${pascalCase('aws-eol-monitor-data')}`, {
      ...commonStackProps,
      stackName: `${props.project}-${props.environment}-eol-monitor-data`,
      description: 'AWS Service EOL Monitor - DynamoDB state table (stateful)',
    });

    const applicationStack = new AwsEolMonitorApplicationStack(
      this,
      `${pascalCase(props.project)}${pascalCase('aws-eol-monitor-application')}`,
      {
        ...commonStackProps,
        params: props.params,
        table: dataStack.table,
        stackName: `${props.project}-${props.environment}-eol-monitor-application`,
        description:
          'AWS Service EOL Monitor - EventBridge Scheduler -> Step Functions (Lambda diff + Bedrock digest) -> SNS',
      },
    );
    applicationStack.addDependency(dataStack);
  }
}
