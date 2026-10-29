/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildStage } from '../helpers/stage';
import { required } from '../helpers/stage';

const countResources = (template: Template): Record<string, number> => {
  const counts: Record<string, number> = {};
  Object.values(template.toJSON().Resources || {}).forEach((resource: any) => {
    counts[resource.Type] = (counts[resource.Type] || 0) + 1;
  });
  return counts;
};

/** Asset hashes of the kubectl layer and handlers change with package releases; mask them. */
const maskAssets = (template: Template): unknown =>
  JSON.parse(JSON.stringify(template.toJSON()).replace(/[0-9a-f]{64}\.zip/g, 'ASSET.zip'));

/**
 * AWS CDK Snapshot Test Suite
 *
 * 1. Detect unintended changes across the whole CloudFormation template of each stack
 * 2. Track changes in the number of resources (the CDK footprint of each cluster type)
 *
 * Detailed property assertions live in test/unit/.
 */
describe('EksManagedNodeGroupVsAutoMode Snapshot', () => {
  const stage = buildStage();
  const stacks: Record<string, cdk.Stack> = {
    Network: stage.network,
    ManagedNodeGroup: required(stage.managedNodeGroup),
    AutoMode: required(stage.autoMode),
  };

  describe.each(Object.entries(stacks))('%s stack', (_name, stack) => {
    const template = Template.fromStack(stack);

    test('Complete CloudFormation template snapshot', () => {
      expect(maskAssets(template)).toMatchSnapshot();
    });

    test('Resource types and counts', () => {
      expect(countResources(template)).toMatchSnapshot();
    });
  });
});
