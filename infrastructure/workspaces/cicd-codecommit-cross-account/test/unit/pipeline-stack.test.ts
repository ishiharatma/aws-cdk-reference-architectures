import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { PipelineStack } from 'lib/stacks/pipeline-stack';
import { testEnvParamsMap, testSharedParams } from 'test/parameters/test-params';

const defaultEnv = {
  account: '111111111111',
  region: 'ap-northeast-1',
};

describe('PipelineStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new PipelineStack(app, 'TestPipeline', {
      env: defaultEnv,
      isAutoDeleteObject: true,
      project: 'testproject',
      sharedParams: testSharedParams,
      envParamsMap: testEnvParamsMap,
    });
    template = Template.fromStack(stack);
  });

  test('creates exactly one CodeCommit repository', () => {
    template.resourceCountIs('AWS::CodeCommit::Repository', 1);
  });

  test('creates one CodePipeline per environment (dev/stg/prd)', () => {
    template.resourceCountIs('AWS::CodePipeline::Pipeline', 3);
  });

  test('creates a Test/Build/Deploy CodeBuild project for each of the 3 environments', () => {
    // 3 environments x 3 CodeBuild projects (Test, Build, Deploy) = 9
    template.resourceCountIs('AWS::CodeBuild::Project', 9);
  });

  test('pipeline for each environment sources from the matching branch', () => {
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'testproject-dev-pipeline',
    });
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'testproject-stg-pipeline',
    });
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'testproject-prd-pipeline',
    });
  });

  test('Deploy CodeBuild role is granted sts:AssumeRole on the matching cross-account role', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowAssumeCrossAccountDeployRole',
            Effect: 'Allow',
            Action: 'sts:AssumeRole',
            Resource: 'arn:aws:iam::222222222222:role/testproject-stg-cross-account-deploy-role',
          }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowAssumeCrossAccountDeployRole',
            Effect: 'Allow',
            Action: 'sts:AssumeRole',
            Resource: 'arn:aws:iam::333333333333:role/testproject-prd-cross-account-deploy-role',
          }),
        ]),
      },
    });
  });

  test('each environment gets its own dedicated artifact bucket', () => {
    template.resourceCountIs('AWS::S3::Bucket', 3);
  });
});
