import * as cdk from 'aws-cdk-lib';
import { Environment } from '@common/parameters/environments';
import { ClaudeManagedAgentsLambdaMicrovmsStack } from 'lib/stacks/claude-managed-agents-lambda-microvms-stack';
import { EnvParams } from 'parameters/environments';
import { testParams } from './parameters/test-params';

export const defaultEnv = { account: '123456789012', region: 'ap-northeast-1' };

/** Builds the stack with the test parameters, optionally overriding parts of them. */
export const buildStack = (overrides: Partial<EnvParams> = {}, app = new cdk.App()) =>
  new ClaudeManagedAgentsLambdaMicrovmsStack(app, 'Main', {
    project: 'test',
    environment: Environment.TEST,
    isAutoDeleteObject: true,
    env: defaultEnv,
    envParams: { ...testParams, ...overrides },
  });
