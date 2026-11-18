/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { LambdaMicrovmsCodexAppserverStack } from 'lib/stacks/lambda-microvms-codex-appserver-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'test';
const envName: Environment = Environment.TEST;

const envParams = params[envName];
if (!envParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

/**
 * AWS CDK Snapshot Test Suite
 *
 * 1. Detect unintended changes across the whole CloudFormation template
 * 2. Provide a safety net during refactoring
 * 3. Track changes in the number of resources
 *
 * Detailed property assertions live in test/unit/.
 */
const countResources = (template: Template): Record<string, number> => {
  const counts: Record<string, number> = {};
  Object.values(template.toJSON().Resources || {}).forEach((resource: any) => {
    counts[resource.Type] = (counts[resource.Type] || 0) + 1;
  });
  return counts;
};

describe('LambdaMicrovmsCodexAppserverStack (NetworkConnector L2) Snapshot', () => {
  const app = new cdk.App();
  const stack = new LambdaMicrovmsCodexAppserverStack(app, 'LambdaMicrovmsCodexAppserverL2', {
    project: projectName,
    environment: envName,
    isAutoDeleteObject: true,
    env: testEnv,
    params: envParams,
    networkConnectorImpl: 'l2',
  });
  const stackTemplate = Template.fromStack(stack);

  test('Complete CloudFormation template snapshot', () => {
    expect(stackTemplate.toJSON()).toMatchSnapshot();
  });

  test('Resource types and counts', () => {
    expect(countResources(stackTemplate)).toMatchSnapshot();
  });
});

describe('LambdaMicrovmsCodexAppserverStack Snapshot', () => {
  const app = new cdk.App();
  const stack = new LambdaMicrovmsCodexAppserverStack(app, 'LambdaMicrovmsCodexAppserver', {
    project: projectName,
    environment: envName,
    isAutoDeleteObject: true,
    env: testEnv,
    params: envParams,
  });
  const stackTemplate = Template.fromStack(stack);

  test('Complete CloudFormation template snapshot', () => {
    expect(stackTemplate.toJSON()).toMatchSnapshot();
  });

  test('Resource types and counts', () => {
    const templateJson = stackTemplate.toJSON();
    const resourceCounts: Record<string, number> = {};
    Object.values(templateJson.Resources || {}).forEach((resource: any) => {
      resourceCounts[resource.Type] = (resourceCounts[resource.Type] || 0) + 1;
    });
    expect(resourceCounts).toMatchSnapshot();
  });
});
