import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Environment } from '@common/parameters/environments';
import { LambdaManagedInstancesGpuStack } from 'lib/stacks/lambda-managed-instances-gpu-stack';
import { EnvParams, params } from 'parameters/environments';
import '../parameters';

export const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
export const projectName = 'test';
export const envName: Environment = Environment.TEST;

/** Feature flags from cdk.json, so tests synthesize with the same behaviour as a real deploy. */
const cdkJsonContext: Record<string, unknown> = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../cdk.json'), 'utf8'),
).context;

/** A new App carrying the cdk.json feature flags. */
export function newApp(): cdk.App {
  return new cdk.App({ context: cdkJsonContext });
}

/** The registered test-environment parameters. */
export function testParams(): EnvParams {
  const base = params[envName];
  if (!base) {
    throw new Error(`No parameters found for environment: ${envName}`);
  }
  return base;
}

/**
 * Build the stack for tests. Docker image assets are not built during synth in
 * tests; the asset hash is derived from the source directory, so snapshots stay
 * deterministic.
 */
export function buildStack(app?: cdk.App, overrides: Partial<EnvParams> = {}): LambdaManagedInstancesGpuStack {
  const envParams: EnvParams = { ...testParams(), ...overrides };
  return new LambdaManagedInstancesGpuStack(app ?? newApp(), 'LambdaManagedInstancesGpu', {
    project: projectName,
    environment: envName,
    isAutoDeleteObject: true,
    env: testEnv,
    params: envParams,
  });
}
