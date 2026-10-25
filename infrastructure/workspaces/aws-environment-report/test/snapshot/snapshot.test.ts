/* eslint-disable @typescript-eslint/no-explicit-any */
import { Template } from 'aws-cdk-lib/assertions';
import { buildStacks } from 'test/helpers/stack';

const countResources = (template: Template): Record<string, number> => {
  const counts: Record<string, number> = {};
  Object.values(template.toJSON().Resources || {}).forEach((resource: any) => {
    counts[resource.Type] = (counts[resource.Type] || 0) + 1;
  });
  return counts;
};

/**
 * Asset hashes (esbuild-bundled Lambdas, the report-builder image) change
 * with any source edit; mask them so the snapshot tracks the infrastructure.
 */
const maskAssets = (template: Template): unknown =>
  JSON.parse(JSON.stringify(template.toJSON()).replace(/[0-9a-f]{64}/g, 'ASSET_HASH'));

/**
 * AWS CDK Snapshot Test Suite
 *
 * 1. Detect unintended changes across the whole CloudFormation template
 * 2. Track changes in the number of resources
 *
 * Detailed property assertions live in test/unit/.
 */
const { data, application } = buildStacks();

describe.each([
  ['DataStack', Template.fromStack(data)],
  ['ApplicationStack', Template.fromStack(application)],
])('%s Snapshot', (_name, template) => {
  test('Complete CloudFormation template snapshot', () => {
    expect(maskAssets(template)).toMatchSnapshot();
  });

  test('Resource types and counts', () => {
    expect(countResources(template)).toMatchSnapshot();
  });
});
