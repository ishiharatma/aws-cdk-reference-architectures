import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { normalizeAssetHashes } from '@common/test-helpers/normalize-asset-hashes';
import { RepositoryStack } from 'lib/stacks/repository-stack';
import { PipelineStack } from 'lib/stacks/pipeline-stack';
import { testEnvParams, testSharedParams } from 'test/parameters/test-params';

/**
 * AWS CDK Snapshot Test Suite
 *
 * Detects unintended changes to the synthesized CloudFormation templates
 * across refactors. Detailed resource/behavior assertions live in test/unit/.
 */
describe('Stack Snapshot Tests', () => {
  const app = new cdk.App();
  const env = { account: '111111111111', region: 'ap-northeast-1' };

  const repositoryStack = new RepositoryStack(app, 'SnapshotRepository', {
    env,
    project: 'testproject',
    sharedParams: testSharedParams,
    envParams: testEnvParams,
  });

  const pipelineStack = new PipelineStack(app, 'SnapshotPipeline', {
    env,
    isAutoDeleteObject: true,
    project: 'testproject',
    environment: Environment.DEVELOPMENT,
    sharedParams: testSharedParams,
    envParams: testEnvParams,
    repository: repositoryStack.repository,
  });

  const repositoryTemplate = Template.fromStack(repositoryStack);
  const pipelineTemplate = Template.fromStack(pipelineStack);

  test('RepositoryStack CloudFormation template snapshot', () => {
    expect(normalizeAssetHashes(repositoryTemplate.toJSON())).toMatchSnapshot();
  });

  test('PipelineStack CloudFormation template snapshot', () => {
    expect(normalizeAssetHashes(pipelineTemplate.toJSON())).toMatchSnapshot();
  });
});
