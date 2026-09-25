import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { RepositoryStack } from 'lib/stacks/repository-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envParams = params[Environment.TEST];
if (!envParams) {
  throw new Error('No parameters found for test environment');
}

const build = (isAutoDeleteObject: boolean) => {
  const app = new cdk.App();
  const stack = new RepositoryStack(app, 'Repository', {
    project: 'test',
    environment: Environment.TEST,
    isAutoDeleteObject,
    env: testEnv,
    params: envParams,
  });
  return Template.fromStack(stack);
};

describe('RepositoryStack', () => {
  test('creates one CodeCommit repository named by the shared convention, seeded on main', () => {
    const template = build(true);
    template.resourceCountIs('AWS::CodeCommit::Repository', 1);
    template.hasResourceProperties('AWS::CodeCommit::Repository', {
      RepositoryName: 'test-test-cdkp-app',
      Code: { BranchName: 'main', S3: { Bucket: Match.stringLikeRegexp('assets'), Key: Match.stringLikeRegexp('\\.zip$') } },
    });
  });

  test('the name matches what the pipeline stack in app/ derives (no cross-stack reference needed)', () => {
    // Imported the same way the pipeline stack does; a mismatch would make the pipeline watch nothing.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { repositoryName } = require('../../app/lib/naming');
    expect(repositoryName('test', 'test')).toBe('test-test-cdkp-app');
  });

  test('repository is deleted with the stack outside production and retained in production', () => {
    build(true).hasResource('AWS::CodeCommit::Repository', { DeletionPolicy: 'Delete' });
    build(false).hasResource('AWS::CodeCommit::Repository', { DeletionPolicy: 'Retain' });
  });

  test('outputs the values the check script and README use', () => {
    const outputs = Object.keys(build(true).toJSON().Outputs);
    ['RepositoryName', 'CloneUrlGrc', 'PipelineStackName'].forEach((name) => expect(outputs).toContain(name));
  });
});
