import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { RepositoryStack } from 'lib/stacks/repository-stack';
import { PipelineStack } from 'lib/stacks/pipeline-stack';
import { testEnvParams, testSharedParams } from 'test/parameters/test-params';

describe('CDK Nag AwsSolutions Pack', () => {
  let app: cdk.App;
  let repositoryStack: RepositoryStack;
  let pipelineStack: PipelineStack;

  beforeAll(() => {
    app = new cdk.App();
    const env = { account: '111111111111', region: 'ap-northeast-1' };

    repositoryStack = new RepositoryStack(app, 'NagRepository', {
      env,
      project: 'testproject',
      sharedParams: testSharedParams,
      envParams: testEnvParams,
    });

    pipelineStack = new PipelineStack(app, 'NagPipeline', {
      env,
      isAutoDeleteObject: true,
      project: 'testproject',
      environment: Environment.DEVELOPMENT,
      sharedParams: testSharedParams,
      envParams: testEnvParams,
      repository: repositoryStack.repository,
    });

    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  });

  test.each([
    ['RepositoryStack', () => repositoryStack],
    ['PipelineStack', () => pipelineStack],
  ])('%s: no unsuppressed warnings', (_name, getStack) => {
    const warnings = Annotations.fromStack(getStack()).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    if (warnings.length > 0) {
      console.log(`\n=== CDK Nag Warnings (${_name}) ===`);
      warnings.forEach((warning, index) => {
        console.log(`\nWarning ${index + 1}:`);
        console.log(`  Path: ${warning.id}`);
        console.log(`  Entry:`, JSON.stringify(warning.entry, null, 2));
      });
    }
    expect(warnings).toHaveLength(0);
  });

  test.each([
    ['RepositoryStack', () => repositoryStack],
    ['PipelineStack', () => pipelineStack],
  ])('%s: no unsuppressed errors', (_name, getStack) => {
    const errors = Annotations.fromStack(getStack()).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    if (errors.length > 0) {
      console.log(`\n=== CDK Nag Errors (${_name}) ===`);
      errors.forEach((error, index) => {
        console.log(`\nError ${index + 1}:`);
        console.log(`  Path: ${error.id}`);
        console.log(`  Entry:`, JSON.stringify(error.entry, null, 2));
      });
    }
    expect(errors).toHaveLength(0);
  });
});
