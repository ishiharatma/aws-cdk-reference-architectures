import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { CrossAccountRoleStack } from 'lib/stacks/cross-account-role-stack';

describe('CrossAccountRoleStack', () => {
  test('creates a role trusting the dev account Deploy CodeBuild role by fixed name', () => {
    const app = new cdk.App();
    const stack = new CrossAccountRoleStack(app, 'TestCrossAccountRole', {
      env: { account: '222222222222', region: 'ap-northeast-1' },
      project: 'testproject',
      targetEnv: Environment.STAGING,
      devAccountId: '111111111111',
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::IAM::Role', 1);
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'testproject-stg-cross-account-deploy-role',
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              AWS: 'arn:aws:iam::111111111111:role/testproject-stg-deploy-build-role',
            },
            Action: 'sts:AssumeRole',
          },
        ],
      },
    });
  });

  test('role name is stable for the dev (self-trust) environment', () => {
    const app = new cdk.App();
    const stack = new CrossAccountRoleStack(app, 'TestCrossAccountRoleDev', {
      env: { account: '111111111111', region: 'ap-northeast-1' },
      project: 'testproject',
      targetEnv: Environment.DEVELOPMENT,
      devAccountId: '111111111111',
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'testproject-dev-cross-account-deploy-role',
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              AWS: 'arn:aws:iam::111111111111:role/testproject-dev-deploy-build-role',
            },
            Action: 'sts:AssumeRole',
          },
        ],
      },
    });
  });
});
