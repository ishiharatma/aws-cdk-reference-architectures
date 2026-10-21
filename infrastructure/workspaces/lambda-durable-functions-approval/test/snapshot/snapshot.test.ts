/* eslint-disable @typescript-eslint/no-explicit-any */
import { Template } from 'aws-cdk-lib/assertions';
import { buildStack } from '../helpers/stack';

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
describe('LambdaDurableFunctionsApprovalStack Snapshot', () => {
  const template = Template.fromStack(buildStack());

  test('Complete CloudFormation template snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });

  test('Resource types and counts', () => {
    expect(countResources(template)).toMatchSnapshot();
  });
});
