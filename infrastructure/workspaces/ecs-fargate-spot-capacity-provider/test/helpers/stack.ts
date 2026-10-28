import * as cdk from 'aws-cdk-lib';
import { Environment } from '@common/parameters/environments';
import { EnvParams, ServiceParams, params } from 'parameters/environments';
import { EcsFargateSpotCapacityProviderStack } from 'lib/stacks/ecs-fargate-spot-capacity-provider-stack';
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

/** The stack wired the same way as the stage, with optional service parameter overrides. */
export function buildStack(
  options: { app?: cdk.App; service?: Partial<ServiceParams>; allowedIpv6s?: string[] } = {},
): EcsFargateSpotCapacityProviderStack {
  const base = testParams();
  return new EcsFargateSpotCapacityProviderStack(options.app ?? new cdk.App(), 'EcsFargateSpot', {
    project: projectName,
    environment: envName,
    isAutoDeleteObject: true,
    env: testEnv,
    envParams: { ...base, service: { ...base.service, ...options.service } },
    allowedIps: [clientIp],
    allowedIpv6s: options.allowedIpv6s,
  });
}
