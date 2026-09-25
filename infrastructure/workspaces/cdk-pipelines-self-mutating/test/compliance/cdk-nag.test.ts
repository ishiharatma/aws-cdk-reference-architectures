import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { RepositoryStack } from 'lib/stacks/repository-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envName: Environment = Environment.TEST;
const envParams = params[envName];
if (!envParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

// The pipeline and application stacks (app/) are checked by app/test/nag.test.ts, which also runs in the pipeline's Build stage.
describe('CDK Nag AwsSolutions Pack (repository stack)', () => {
  let stack: RepositoryStack;

  beforeAll(() => {
    const app = new cdk.App();
    stack = new RepositoryStack(app, 'ExampleTestCdkpRepository', {
      project: 'example',
      environment: envName,
      isAutoDeleteObject: true,
      env: testEnv,
      params: envParams,
    });
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  });

  test('no unsuppressed Warnings', () => {
    expect(Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'))).toHaveLength(0);
  });

  test('no unsuppressed Errors', () => {
    expect(Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'))).toHaveLength(0);
  });
});
