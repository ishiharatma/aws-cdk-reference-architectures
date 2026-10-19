import * as cdk from 'aws-cdk-lib';
import { Environment } from '@common/parameters/environments';
import { LambdaWebFunctionsExpressStack } from 'lib/stacks/lambda-web-functions-express-stack';
import { EnvParams, params } from 'parameters/environments';
import '../parameters';

export const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
export const projectName = 'test';
export const envName: Environment = Environment.TEST;
export const webAclArn = 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/test/00000000-0000-0000-0000-000000000000';

/**
 * Build the main stack for tests. esbuild bundling is skipped
 * (`aws:cdk:bundling-stacks: []`) so the asset hash is derived from the source
 * directory and snapshots stay deterministic without running esbuild.
 */
export function buildStack(app?: cdk.App, overrides: Partial<EnvParams> = {}): LambdaWebFunctionsExpressStack {
  const base = params[envName];
  if (!base) {
    throw new Error(`No parameters found for environment: ${envName}`);
  }
  const envParams: EnvParams = { ...base, ...overrides };
  const scope = app ?? new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  return new LambdaWebFunctionsExpressStack(scope, 'LambdaWebFunctionsExpress', {
    project: projectName,
    environment: envName,
    isAutoDeleteObject: true,
    env: testEnv,
    params: envParams,
    webAclArn,
  });
}
