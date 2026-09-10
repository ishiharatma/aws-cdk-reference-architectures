import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { PipelineStack } from 'lib/stacks/pipeline-stack';
import { CrossAccountRoleStack } from 'lib/stacks/cross-account-role-stack';
import { testEnvParamsMap, testSharedParams } from 'test/parameters/test-params';

describe('CDK Nag AwsSolutions Pack', () => {
  let app: cdk.App;
  let pipelineStack: PipelineStack;
  let crossAccountRoleStack: CrossAccountRoleStack;

  beforeAll(() => {
    app = new cdk.App();

    pipelineStack = new PipelineStack(app, 'NagPipeline', {
      env: { account: '111111111111', region: 'ap-northeast-1' },
      isAutoDeleteObject: true,
      project: 'testproject',
      sharedParams: testSharedParams,
      envParamsMap: testEnvParamsMap,
    });

    crossAccountRoleStack = new CrossAccountRoleStack(app, 'NagCrossAccountRole', {
      env: { account: '222222222222', region: 'ap-northeast-1' },
      project: 'testproject',
      targetEnv: Environment.STAGING,
      devAccountId: '111111111111',
    });

    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  });

  test.each([
    ['PipelineStack', () => pipelineStack],
    ['CrossAccountRoleStack', () => crossAccountRoleStack],
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
    ['PipelineStack', () => pipelineStack],
    ['CrossAccountRoleStack', () => crossAccountRoleStack],
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
