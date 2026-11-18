import * as cdk from 'aws-cdk-lib';
import { Environment } from '@common/parameters/environments';
import { ClaudeManagedAgentsLambdaMicrovmsStack } from 'lib/stacks/claude-managed-agents-lambda-microvms-stack';
import { EnvParams } from 'parameters/environments';
import { testParams } from './parameters/test-params';

export const defaultEnv = { account: '123456789012', region: 'ap-northeast-1' };

/** Builds the stack with the test parameters, optionally overriding parts of them. */
export const buildStack = (overrides: Partial<EnvParams> = {}, app = new cdk.App(), networkConnectorImpl: 'l1' | 'l2' = 'l1') =>
  new ClaudeManagedAgentsLambdaMicrovmsStack(app, networkConnectorImpl === 'l2' ? 'MainL2' : 'Main', {
    project: 'test',
    environment: Environment.TEST,
    isAutoDeleteObject: true,
    env: defaultEnv,
    envParams: { ...testParams, ...overrides },
    networkConnectorImpl,
  });

/** Network settings that make the stack define its own (firewall-inspected) egress connector. */
export const firewallNetwork: Partial<EnvParams> = {
  network: { egressMode: 'firewall', ingressMode: 'none', allowedDomains: ['api.anthropic.com', '.amazonaws.com'] },
};
