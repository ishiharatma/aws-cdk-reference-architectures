/* eslint-disable @typescript-eslint/no-explicit-any */
import { Template } from 'aws-cdk-lib/assertions';
import { buildStacks } from '../helpers/stack';

const countResources = (template: Template): Record<string, number> => {
  const counts: Record<string, number> = {};
  Object.values(template.toJSON().Resources || {}).forEach((resource: any) => {
    counts[resource.Type] = (counts[resource.Type] || 0) + 1;
  });
  return counts;
};

/** Asset hashes of the bundled probe function change with esbuild output; mask them. */
const maskAssets = (template: Template): unknown =>
  JSON.parse(JSON.stringify(template.toJSON()).replace(/[0-9a-f]{64}\.zip/g, 'ASSET.zip'));

/**
 * AWS CDK Snapshot Test Suite
 *
 * 1. Detect unintended changes across the whole CloudFormation template
 * 2. Track changes in the number of resources
 *
 * Detailed property assertions live in test/unit/.
 */
const { platform, app } = buildStacks();

describe.each([
  ['PlatformStack', Template.fromStack(platform)],
  ['AppStack', Template.fromStack(app)],
])('%s Snapshot', (_name, template) => {
  test('Complete CloudFormation template snapshot', () => {
    expect(maskAssets(template)).toMatchSnapshot();
  });

  test('Resource types and counts', () => {
    expect(countResources(template)).toMatchSnapshot();
  });
});
