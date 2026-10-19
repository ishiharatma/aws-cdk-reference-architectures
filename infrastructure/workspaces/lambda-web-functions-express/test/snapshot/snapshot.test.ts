/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CloudfrontWafStack } from 'lib/stacks/cloudfront-waf-stack';
import { buildStack, envName, projectName, testEnv } from '../helpers/stack';

const countResources = (template: Template): Record<string, number> => {
  const counts: Record<string, number> = {};
  Object.values(template.toJSON().Resources || {}).forEach((resource: any) => {
    counts[resource.Type] = (counts[resource.Type] || 0) + 1;
  });
  return counts;
};

/**
 * AWS CDK Snapshot Test Suite
 *
 * 1. Detect unintended changes across the whole CloudFormation template
 * 2. Provide a safety net during refactoring
 * 3. Track changes in the number of resources
 *
 * Detailed property assertions live in test/unit/.
 */
describe('LambdaWebFunctionsExpressStack Snapshot', () => {
  const template = Template.fromStack(buildStack());

  test('Complete CloudFormation template snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });

  test('Resource types and counts', () => {
    expect(countResources(template)).toMatchSnapshot();
  });
});

describe('CloudfrontWafStack Snapshot', () => {
  const app = new cdk.App();
  const stack = new CloudfrontWafStack(app, 'CloudfrontWaf', {
    project: projectName,
    environment: envName,
    allowedIps: ['203.0.113.10'],
    rateLimitPerIp: 1000,
    env: { account: testEnv.account, region: 'us-east-1' },
  });
  const template = Template.fromStack(stack);

  test('Complete CloudFormation template snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });

  test('Resource types and counts', () => {
    expect(countResources(template)).toMatchSnapshot();
  });
});
