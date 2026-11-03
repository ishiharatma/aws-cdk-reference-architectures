/* eslint-disable @typescript-eslint/no-explicit-any */
import { Template } from 'aws-cdk-lib/assertions';
import { buildStage, templates } from '../helpers/stage';

const countResources = (template: Template): Record<string, number> => {
  const counts: Record<string, number> = {};
  Object.values(template.toJSON().Resources || {}).forEach((resource: any) => {
    counts[resource.Type] = (counts[resource.Type] || 0) + 1;
  });
  return counts;
};

/** Asset hashes change with CDK releases and handler edits; mask them. */
const maskAssets = (template: Template): unknown =>
  JSON.parse(JSON.stringify(template.toJSON()).replace(/[0-9a-f]{64}(\.zip)?/g, 'ASSET'));

/**
 * AWS CDK Snapshot Test Suite
 *
 * 1. Detect unintended changes across every CloudFormation template of the stage
 * 2. Track changes in the number of resources per stack
 *
 * Detailed property assertions live in test/unit/.
 */
describe('ClientVpnVsOpenvpnWireguardStage Snapshot', () => {
  const all = templates(buildStage());

  test.each(Object.keys(all))('%s: complete CloudFormation template snapshot', (name) => {
    expect(maskAssets(all[name])).toMatchSnapshot();
  });

  test.each(Object.keys(all))('%s: resource types and counts', (name) => {
    expect(countResources(all[name])).toMatchSnapshot();
  });
});
