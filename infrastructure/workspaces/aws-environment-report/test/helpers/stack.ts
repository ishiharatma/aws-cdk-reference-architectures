import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Environment } from '@common/parameters/environments';
import { loadCdkContext } from '@common/test-helpers/test-context';
import { AwsEnvironmentReportApplicationStack } from 'lib/stacks/aws-environment-report-application-stack';
import { AwsEnvironmentReportDataStack } from 'lib/stacks/aws-environment-report-data-stack';
import { EnvParams, params } from 'parameters/environments';
import '../parameters';

export const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
export const projectName = 'TestProject';
export const envName: Environment = Environment.TEST;

/** Test-environment parameters. */
export function testParams(): EnvParams {
  const base = params[envName];
  if (!base) {
    throw new Error(`No parameters found for environment: ${envName}`);
  }
  return base;
}

/** A new App with the workspace's cdk.json context (feature flags). */
export function newApp(): cdk.App {
  return new cdk.App({ context: loadCdkContext(path.resolve(__dirname, '../../cdk.json')) });
}

/** Data and application stacks wired the same way as the stage. */
export function buildStacks(options: { app?: cdk.App; params?: EnvParams } = {}): {
  data: AwsEnvironmentReportDataStack;
  application: AwsEnvironmentReportApplicationStack;
} {
  const scope = options.app ?? newApp();
  const common = {
    project: projectName,
    environment: envName,
    env: testEnv,
    isAutoDeleteObject: true,
    params: options.params ?? testParams(),
  };
  const data = new AwsEnvironmentReportDataStack(scope, 'Data', common);
  const application = new AwsEnvironmentReportApplicationStack(scope, 'Application', {
    ...common,
    bucket: data.bucket,
    key: data.key,
    webhookSecret: data.webhookSecret,
  });
  return { data, application };
}
