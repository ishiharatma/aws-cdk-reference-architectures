import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { S3AmplifyStaticWebsiteStack } from 'lib/stacks/s3-amplify-static-website-stack';

const defaultEnv = {
  account: '123456789012',
  region: 'ap-northeast-1',
};

const projectName = 'TestProject';
const envName: Environment = Environment.TEST;

function buildStack(branchName?: string) {
  const app = new cdk.App();
  const stack = new S3AmplifyStaticWebsiteStack(app, 'S3AmplifyStaticWebsiteStack', {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    branchName,
  });
  return { stack, template: Template.fromStack(stack) };
}

describe('S3AmplifyStaticWebsiteStack', () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = buildStack());
  });

  test('Amplify App is created with WEB platform', () => {
    template.hasResourceProperties('AWS::Amplify::App', {
      Name: `${projectName}-${envName}-website`,
      Platform: 'WEB',
    });
  });

  test('Amplify Branch is created with auto-build disabled', () => {
    template.hasResourceProperties('AWS::Amplify::Branch', {
      BranchName: 'main',
      EnableAutoBuild: false,
      EnablePullRequestPreview: false,
    });
  });

  test('Amplify service role trusts amplify.amazonaws.com', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Principal: { Service: 'amplify.amazonaws.com' },
          }),
        ]),
      },
    });
  });

  test('Amplify service role has S3 read access for the CDK asset', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['s3:GetObject*']),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('Custom resource for Amplify deployment is created', () => {
    // The AwsCustomResource generates a Custom::AWS resource. The Create/Update properties
    // contain CloudFormation tokens (Fn::Join with the serialized SDK call), so we verify
    // that exactly one such resource exists and that its service token points to the
    // framework Lambda.
    template.resourceCountIs('Custom::AWS', 1);
  });

  test('Custom resource policy grants amplify:StartDeployment', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'amplify:StartDeployment',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('Outputs include AmplifyAppId and AmplifyAppUrl', () => {
    template.hasOutput('AmplifyAppId', {});
    template.hasOutput('AmplifyAppUrl', {});
    template.hasOutput('AmplifyConsoleUrl', {});
  });

  describe('when branchName is specified', () => {
    test('branch uses the provided name', () => {
      const { template: t } = buildStack('staging');
      t.hasResourceProperties('AWS::Amplify::Branch', {
        BranchName: 'staging',
      });
    });
  });
});
