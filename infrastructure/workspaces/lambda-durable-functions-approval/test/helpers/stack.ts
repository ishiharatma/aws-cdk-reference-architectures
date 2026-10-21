import * as cdk from 'aws-cdk-lib';
import { Environment } from '@common/parameters/environments';
import { LambdaDurableFunctionsApprovalStack } from 'lib/stacks/lambda-durable-functions-approval-stack';
import { EnvParams, params } from 'parameters/environments';
import '../parameters';

export const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
export const projectName = 'test';
export const envName: Environment = Environment.TEST;

/**
 * Build the stack for tests. esbuild bundling runs (no `aws:cdk:bundling-stacks: []`):
 * with bundling skipped, NodejsFunction hashes its whole project root (`infrastructure/`,
 * including node_modules and cdk.out), so the asset keys differ between machines and the
 * snapshot fails in CI. The bundled output hash depends only on the sources and the lockfile.
 */
export function buildStack(
  app?: cdk.App,
  overrides: Partial<EnvParams> = {}
): LambdaDurableFunctionsApprovalStack {
  const base = params[envName];
  if (!base) {
    throw new Error(`No parameters found for environment: ${envName}`);
  }
  const envParams: EnvParams = { ...base, ...overrides };
  const scope = app ?? new cdk.App();
  return new LambdaDurableFunctionsApprovalStack(scope, 'LambdaDurableFunctionsApproval', {
    project: projectName,
    environment: envName,
    isAutoDeleteObject: true,
    env: testEnv,
    params: envParams,
  });
}
