import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RepositoryStack } from 'lib/stacks/repository-stack';
import { testEnvParamsMap, testSharedParams } from 'test/parameters/test-params';

const defaultEnv = {
  account: '111111111111',
  region: 'ap-northeast-1',
};

describe('RepositoryStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new RepositoryStack(app, 'TestRepository', {
      env: defaultEnv,
      project: 'testproject',
      sharedParams: testSharedParams,
      envParamsMap: testEnvParamsMap,
    });
    template = Template.fromStack(stack);
  });

  test('creates exactly one CodeCommit repository', () => {
    template.resourceCountIs('AWS::CodeCommit::Repository', 1);
  });

  test('creates a fixed-name source-action role per other environment (stg/prd), trusting that account\'s pipeline role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'testproject-pipeline-source-action-222222222222',
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Effect: 'Allow',
            Principal: { AWS: 'arn:aws:iam::222222222222:role/testproject-stg-pipeline-role' },
            Action: 'sts:AssumeRole',
          }),
        ],
      },
    });
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'testproject-pipeline-source-action-333333333333',
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Effect: 'Allow',
            Principal: { AWS: 'arn:aws:iam::333333333333:role/testproject-prd-pipeline-role' },
            Action: 'sts:AssumeRole',
          }),
        ],
      },
    });
  });

  test('does not create a source-action role for the dev environment itself', () => {
    // dev's pipeline lives in this same account, so it needs no cross-account
    // source-action role — only stg/prd (asserted above) get one.
    template.resourcePropertiesCountIs('AWS::IAM::Role', {
      RoleName: 'testproject-pipeline-source-action-111111111111',
    }, 0);
  });

  test('forwards each branch\'s push events to the matching account\'s default event bus', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        detail: {
          referenceName: ['staging'],
        },
      },
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: 'arn:aws:events:ap-northeast-1:222222222222:event-bus/default',
        }),
      ]),
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        detail: {
          referenceName: ['main'],
        },
      },
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: 'arn:aws:events:ap-northeast-1:333333333333:event-bus/default',
        }),
      ]),
    });
  });
});
