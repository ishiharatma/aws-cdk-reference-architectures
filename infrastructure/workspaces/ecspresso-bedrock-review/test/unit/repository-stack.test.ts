import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { RepositoryStack } from 'lib/stacks/repository-stack';
import { testEnvParams, testSharedParams } from 'test/parameters/test-params';

describe('RepositoryStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new RepositoryStack(app, 'TestRepository', {
      env: { account: '111111111111', region: 'ap-northeast-1' },
      project: 'testproject',
      sharedParams: testSharedParams,
      envParams: testEnvParams,
    });
    template = Template.fromStack(stack);
  });

  test('creates exactly one CodeCommit repository seeded on the branch from envParams', () => {
    template.resourceCountIs('AWS::CodeCommit::Repository', 1);
    template.hasResourceProperties('AWS::CodeCommit::Repository', {
      RepositoryName: 'ecspresso-bedrock-review-app',
      Code: {
        BranchName: 'develop',
      },
    });
  });
});
