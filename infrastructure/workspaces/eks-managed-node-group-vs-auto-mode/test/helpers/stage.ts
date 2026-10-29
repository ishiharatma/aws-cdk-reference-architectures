import * as cdk from 'aws-cdk-lib';
import { Environment } from '@common/parameters/environments';
import { EnvParams, params } from 'parameters/environments';
import { EksManagedNodeGroupVsAutoModeStage } from 'lib/stages/eks-managed-node-group-vs-auto-mode-stage';
import '../parameters';

export const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
export const projectName = 'test';
export const envName: Environment = Environment.TEST;
export const clientIp = '203.0.113.10';
export const adminPrincipalArn = 'arn:aws:iam::123456789012:role/Admin';

/** Test-environment parameters. */
export function testParams(): EnvParams {
  const base = params[envName];
  if (!base) {
    throw new Error(`No parameters found for environment: ${envName}`);
  }
  return base;
}

/** The stage wired the same way as bin/, with optional parameter overrides. */
export function buildStage(
  options: { app?: cdk.App; params?: Partial<EnvParams>; adminPrincipalArn?: string } = {},
): EksManagedNodeGroupVsAutoModeStage {
  return new EksManagedNodeGroupVsAutoModeStage(options.app ?? new cdk.App(), 'Test', {
    project: projectName,
    environment: envName,
    env: testEnv,
    terminationProtection: false,
    params: { ...testParams(), ...options.params },
    allowedIps: [clientIp],
    adminPrincipalArn: 'adminPrincipalArn' in options ? options.adminPrincipalArn : adminPrincipalArn,
  });
}

/** Returns a stack that the default test parameters always create (avoids non-null assertions). */
export function required<T>(stack: T | undefined): T {
  if (!stack) {
    throw new Error('Stack is not created with the current parameters');
  }
  return stack;
}
