import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { RepositoryStack } from 'lib/stacks/repository-stack';
import { PipelineStack } from 'lib/stacks/pipeline-stack';
import { getTestEnvParams, testEnvParamsMap, testSharedParams } from 'test/parameters/test-params';

/**
 * AWS CDK Snapshot Test Suite
 *
 * Detects unintended changes to the synthesized CloudFormation templates
 * across refactors. Detailed resource/behavior assertions live in test/unit/.
 */
describe('Stack Snapshot Tests', () => {
  const app = new cdk.App();

  const repositoryStack = new RepositoryStack(app, 'SnapshotRepository', {
    env: { account: '111111111111', region: 'ap-northeast-1' },
    project: 'testproject',
    sharedParams: testSharedParams,
    envParamsMap: testEnvParamsMap,
  });

  const devPipelineStack = new PipelineStack(app, 'SnapshotPipelineDev', {
    env: { account: '111111111111', region: 'ap-northeast-1' },
    isAutoDeleteObject: true,
    project: 'testproject',
    environment: Environment.DEVELOPMENT,
    sharedParams: testSharedParams,
    envParams: getTestEnvParams(Environment.DEVELOPMENT),
  });

  const stgPipelineStack = new PipelineStack(app, 'SnapshotPipelineStg', {
    env: { account: '222222222222', region: 'ap-northeast-1' },
    isAutoDeleteObject: true,
    project: 'testproject',
    environment: Environment.STAGING,
    sharedParams: testSharedParams,
    envParams: getTestEnvParams(Environment.STAGING),
  });

  const repositoryTemplate = Template.fromStack(repositoryStack);
  const devPipelineTemplate = Template.fromStack(devPipelineStack);
  const stgPipelineTemplate = Template.fromStack(stgPipelineStack);

  afterAll(() => {
    app.node.children.forEach((child) => {
      if (child instanceof cdk.Stack) {
        child.node.tryRemoveChild('ResourceHandlerCustomResourceProvider');
      }
    });
  });

  test('RepositoryStack CloudFormation template snapshot', () => {
    expect(repositoryTemplate.toJSON()).toMatchSnapshot();
  });

  test('PipelineStack (dev, same-account source) CloudFormation template snapshot', () => {
    expect(devPipelineTemplate.toJSON()).toMatchSnapshot();
  });

  test('PipelineStack (stg, cross-account source) CloudFormation template snapshot', () => {
    expect(stgPipelineTemplate.toJSON()).toMatchSnapshot();
  });
});
