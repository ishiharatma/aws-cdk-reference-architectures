/* eslint-disable @typescript-eslint/no-explicit-any */
import { Template } from 'aws-cdk-lib/assertions';
import { buildStack } from '../helpers/stack';

/**
 * Snapshot tests: detect unintended changes to the whole template and to the
 * resource counts (cost impact). Property-level checks live in test/unit.
 */
describe('Stack Snapshot Tests', () => {
  const template = Template.fromStack(buildStack());

  test('Complete CloudFormation template snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });

  test('Resource types and counts', () => {
    const resourceCounts: Record<string, number> = {};
    Object.values(template.toJSON().Resources || {}).forEach((resource: any) => {
      resourceCounts[resource.Type] = (resourceCounts[resource.Type] || 0) + 1;
    });
    expect(resourceCounts).toMatchSnapshot();
  });
});
