import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { EnvParams, params } from 'parameters/environments';
import { ClientVpnVsOpenvpnWireguardStage } from 'lib/stages/client-vpn-vs-openvpn-wireguard-stage';
import '../parameters';

export const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
export const projectName = 'test';
export const envName: Environment = Environment.TEST;

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
  options: { app?: cdk.App; overrides?: Partial<EnvParams> } = {},
): ClientVpnVsOpenvpnWireguardStage {
  return new ClientVpnVsOpenvpnWireguardStage(options.app ?? new cdk.App(), 'Test', {
    project: projectName,
    environment: envName,
    env: testEnv,
    terminationProtection: false,
    params: { ...testParams(), ...options.overrides },
  });
}

/** Templates of every stack in the stage. */
export function templates(stage: ClientVpnVsOpenvpnWireguardStage): Record<string, Template> {
  const result: Record<string, Template> = {
    target: Template.fromStack(stage.target),
    clientVpn: Template.fromStack(stage.clientVpn),
    openVpn: Template.fromStack(stage.openVpn),
    wireGuard: Template.fromStack(stage.wireGuard),
  };
  if (stage.clientSimulator) {
    result.clientSimulator = Template.fromStack(stage.clientSimulator);
  }
  return result;
}
