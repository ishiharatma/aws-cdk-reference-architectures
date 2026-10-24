import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { validateParams } from 'lib/helpers/validate-params';
import { AwsEnvironmentReportDataStack } from 'lib/stacks/aws-environment-report-data-stack';
import { AwsEnvironmentReportApplicationStack } from 'lib/stacks/aws-environment-report-application-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

/**
 * AWS Environment Report Stage
 *
 * Data (stateful: bucket, KMS key, webhook secret) -> Application (stateless:
 * Scheduler + Step Functions + collectors + report builder + notifier).
 */
export class AwsEnvironmentReportStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    validateParams(props.params);

    const commonStackProps = {
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
    };

    const dataStack = new AwsEnvironmentReportDataStack(
      this,
      `${pascalCase(props.project)}${pascalCase('aws-environment-report-data')}`,
      {
        ...commonStackProps,
        stackName: `${props.project}-${props.environment}-environment-report-data`,
        description: 'AWS Environment Report - report bucket, KMS key, webhook secret (stateful)',
      }
    );

    const applicationStack = new AwsEnvironmentReportApplicationStack(
      this,
      `${pascalCase(props.project)}${pascalCase('aws-environment-report-application')}`,
      {
        ...commonStackProps,
        bucket: dataStack.bucket,
        key: dataStack.key,
        webhookSecret: dataStack.webhookSecret,
        stackName: `${props.project}-${props.environment}-environment-report-application`,
        description:
          'AWS Environment Report - Scheduler -> Step Functions (collectors -> report builder -> webhook notify)',
      }
    );
    applicationStack.addStackDependency(dataStack);
  }
}
