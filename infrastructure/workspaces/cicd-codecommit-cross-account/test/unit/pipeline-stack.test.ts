import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { PipelineStack } from 'lib/stacks/pipeline-stack';
import { getTestEnvParams, testSharedParams } from 'test/parameters/test-params';

describe('PipelineStack — dev (same-account source)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new PipelineStack(app, 'TestPipelineDev', {
      env: { account: '111111111111', region: 'ap-northeast-1' },
      isAutoDeleteObject: true,
      project: 'testproject',
      environment: Environment.DEVELOPMENT,
      sharedParams: testSharedParams,
      envParams: getTestEnvParams(Environment.DEVELOPMENT),
    });
    template = Template.fromStack(stack);
  });

  test('creates exactly one CodePipeline', () => {
    template.resourceCountIs('AWS::CodePipeline::Pipeline', 1);
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'testproject-dev-pipeline',
    });
  });

  test('creates a fixed-name pipeline execution role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'testproject-dev-pipeline-role',
    });
  });

  test('Source action uses a CDK-generated action role, not a fixed cross-account ARN', () => {
    // No `role` was passed to CodeCommitSourceAction, so CDK generates its own
    // per-action IAM role (Fn::GetAtt) instead of a literal cross-account ARN.
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Stages: Match.arrayWith([
        Match.objectLike({
          Name: 'Source',
          Actions: [
            Match.objectLike({
              RoleArn: { 'Fn::GetAtt': Match.anyValue() },
            }),
          ],
        }),
      ]),
    });
  });

  test('does not create an EventBusPolicy (no cross-account event forwarding needed)', () => {
    template.resourceCountIs('AWS::Events::EventBusPolicy', 0);
  });

  test('creates Test/Build/Deploy CodeBuild projects', () => {
    template.resourceCountIs('AWS::CodeBuild::Project', 3);
  });
});

describe('PipelineStack — stg (cross-account source)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new PipelineStack(app, 'TestPipelineStg', {
      env: { account: '222222222222', region: 'ap-northeast-1' },
      isAutoDeleteObject: true,
      project: 'testproject',
      environment: Environment.STAGING,
      sharedParams: testSharedParams,
      envParams: getTestEnvParams(Environment.STAGING),
    });
    template = Template.fromStack(stack);
  });

  test('Source action assumes the dev account\'s fixed-name source-action role', () => {
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Stages: Match.arrayWith([
        Match.objectLike({
          Name: 'Source',
          Actions: [
            Match.objectLike({
              RoleArn: 'arn:aws:iam::111111111111:role/testproject-pipeline-source-action-222222222222',
            }),
          ],
        }),
      ]),
    });
  });

  test('authorizes the dev account to PutEvents onto this account\'s default event bus', () => {
    template.hasResourceProperties('AWS::Events::EventBusPolicy', {
      Statement: Match.objectLike({
        Effect: 'Allow',
        Principal: { AWS: 'arn:aws:iam::111111111111:root' },
        Action: 'events:PutEvents',
      }),
    });
  });

  test('trigger rule filters on the branch and the dev account\'s repository ARN', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        resources: ['arn:aws:codecommit:ap-northeast-1:111111111111:sample-app'],
        detail: {
          referenceName: ['staging'],
        },
      },
    });
  });
});
