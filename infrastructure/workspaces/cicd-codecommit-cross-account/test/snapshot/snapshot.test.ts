import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { PipelineStack } from 'lib/stacks/pipeline-stack';
import { CrossAccountRoleStack } from 'lib/stacks/cross-account-role-stack';
import { testEnvParamsMap, testSharedParams } from 'test/parameters/test-params';

/**
 * AWS CDK Snapshot Test Suite
 *
 * Detects unintended changes to the synthesized CloudFormation templates
 * across refactors. Detailed resource/behavior assertions live in test/unit/.
 */
describe('Stack Snapshot Tests', () => {
  const app = new cdk.App();

  const pipelineStack = new PipelineStack(app, 'SnapshotPipeline', {
    env: { account: '111111111111', region: 'ap-northeast-1' },
    isAutoDeleteObject: true,
    project: 'testproject',
    sharedParams: testSharedParams,
    envParamsMap: testEnvParamsMap,
  });

  const crossAccountRoleStack = new CrossAccountRoleStack(app, 'SnapshotCrossAccountRole', {
    env: { account: '222222222222', region: 'ap-northeast-1' },
    project: 'testproject',
    targetEnv: Environment.STAGING,
    devAccountId: '111111111111',
  });

  const pipelineTemplate = Template.fromStack(pipelineStack);
  const crossAccountRoleTemplate = Template.fromStack(crossAccountRoleStack);

  afterAll(() => {
    app.node.children.forEach((child) => {
      if (child instanceof cdk.Stack) {
        child.node.tryRemoveChild('ResourceHandlerCustomResourceProvider');
      }
    });
  });

  test('PipelineStack CloudFormation template snapshot', () => {
    expect(pipelineTemplate.toJSON()).toMatchSnapshot();
  });

  test('CrossAccountRoleStack CloudFormation template snapshot', () => {
    expect(crossAccountRoleTemplate.toJSON()).toMatchSnapshot();
  });
});
