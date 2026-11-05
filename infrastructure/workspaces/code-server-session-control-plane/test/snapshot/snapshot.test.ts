/* eslint-disable @typescript-eslint/no-explicit-any */
import { Template } from 'aws-cdk-lib/assertions';
import { buildStacks } from 'test/helpers';

/**
 * AWS CDK Snapshot Test Suite
 *
 * Detects unintended changes across each template and tracks resource counts.
 * Detailed property assertions live in test/unit/.
 */
describe('Snapshot', () => {
  const { microvm, ec2, controlPlane, browserAccess, codeCommit } = buildStacks();
  const stacks = { microvm, ec2, controlPlane, browserAccess, codeCommit };

  test.each(Object.entries(stacks))('%s template', (_name, stack) => {
    expect(Template.fromStack(stack).toJSON()).toMatchSnapshot();
  });

  test.each(Object.entries(stacks))('%s resource counts', (_name, stack) => {
    const counts: Record<string, number> = {};
    Object.values(Template.fromStack(stack).toJSON().Resources || {}).forEach((resource: any) => {
      counts[resource.Type] = (counts[resource.Type] || 0) + 1;
    });
    expect(counts).toMatchSnapshot();
  });
});
