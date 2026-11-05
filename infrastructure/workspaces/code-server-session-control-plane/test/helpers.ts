import * as cdk from 'aws-cdk-lib';
import { Environment } from '@common/parameters/environments';
import { params } from 'parameters/environments';
import { BrowserAccessStack } from 'lib/stacks/browser-access-stack';
import { CodeCommitStack } from 'lib/stacks/code-commit-stack';
import { ControlPlaneStack } from 'lib/stacks/control-plane-stack';
import { Ec2ComputeStack } from 'lib/stacks/ec2-compute-stack';
import { MicrovmComputeStack } from 'lib/stacks/microvm-compute-stack';
import './parameters';

const env = { account: '123456789012', region: 'ap-northeast-1' };
const project = 'test';
const environment = Environment.TEST;

/**
 * Builds every stack the way the stage does, with fixed values so templates stay deterministic.
 */
export function buildStacks(app = new cdk.App()) {
  const envParams = params[environment];
  if (!envParams) throw new Error(`No parameters found for environment: ${environment}`);
  const common = { project, environment, env, params: envParams };
  const microvm = new MicrovmComputeStack(app, 'Microvm', { ...common, isAutoDeleteObject: true });
  const ec2 = new Ec2ComputeStack(app, 'Ec2', common);
  const controlPlane = new ControlPlaneStack(app, 'ControlPlane', { ...common, isAutoDeleteObject: true, microvm, ec2 });
  const browserAccess = new BrowserAccessStack(app, 'BrowserAccess', {
    project,
    environment,
    env,
    httpApi: controlPlane.httpApi,
    apiStageName: controlPlane.stageName,
  });
  const codeCommit = new CodeCommitStack(app, 'CodeCommit', {
    env,
    isAutoDeleteObject: true,
    repositoryNames: envParams.codeCommit?.managedRepositoryNames ?? [],
  });
  return { app, microvm, ec2, controlPlane, browserAccess, codeCommit };
}
