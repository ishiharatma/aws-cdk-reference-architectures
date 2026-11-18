import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { EnvParams, params } from 'parameters/environments';
import { WorkspacesManagedAdClosedVpcStage } from 'lib/stages/workspaces-managed-ad-closed-vpc-stage';
import '../parameters';
// Same feature flags as `cdk synth` (jest does not read cdk.json on its own).
import cdkJson from 'cdk.json';

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

/** App with the cdk.json context (feature flags). */
export function newApp(): cdk.App {
  return new cdk.App({ context: cdkJson.context });
}

/** The stage wired the same way as bin/, with optional parameter overrides. */
export function buildStage(
  options: { app?: cdk.App; overrides?: Partial<EnvParams> } = {}
): WorkspacesManagedAdClosedVpcStage {
  return new WorkspacesManagedAdClosedVpcStage(options.app ?? newApp(), 'Test', {
    project: projectName,
    environment: envName,
    env: testEnv,
    terminationProtection: false,
    isAutoDeleteObject: true,
    params: { ...testParams(), ...options.overrides },
  });
}

/** Templates of every stack in the stage. */
export function templates(stage: WorkspacesManagedAdClosedVpcStage): Record<string, Template> {
  return {
    network: Template.fromStack(stage.network),
    directory: Template.fromStack(stage.directory),
    workspaces: Template.fromStack(stage.workspaces),
    usageReport: Template.fromStack(stage.usageReport),
  };
}
