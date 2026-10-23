import * as cdk from 'aws-cdk-lib';
import { Environment } from '@common/parameters/environments';
import { EnvParams, PlatformParams, params } from 'parameters/environments';
import { AppStack } from 'lib/stacks/app-stack';
import { PlatformStack } from 'lib/stacks/platform-stack';
import '../parameters';

export const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
export const projectName = 'test';
export const envName: Environment = Environment.TEST;
export const clientIp = '203.0.113.10';

/** Test-environment parameters. */
export function testParams(): EnvParams {
  const base = params[envName];
  if (!base) {
    throw new Error(`No parameters found for environment: ${envName}`);
  }
  return base;
}

/** Platform and app stacks wired the same way as the stage. */
export function buildStacks(
  options: { app?: cdk.App; platform?: Partial<PlatformParams>; appParams?: Partial<EnvParams["app"]> } = {},
): { platform: PlatformStack; app: AppStack } {
  const scope = options.app ?? new cdk.App();
  const base = testParams();
  const platformParams = { ...base.platform, ...options.platform };
  const platform = new PlatformStack(scope, 'Platform', {
    project: projectName,
    environment: envName,
    isAutoDeleteObject: true,
    env: testEnv,
    params: platformParams,
    allowedIps: [clientIp],
  });
  const app = new AppStack(scope, 'App', {
    project: projectName,
    environment: envName,
    isAutoDeleteObject: true,
    env: testEnv,
    params: { ...base.app, ...options.appParams },
    vpc: platform.vpc,
    cluster: platform.cluster,
    testTrafficHeader: platformParams.testTrafficHeader,
  });
  app.addStackDependency(platform);
  return { platform, app };
}
