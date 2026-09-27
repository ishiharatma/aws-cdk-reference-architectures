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
  const stack = new S3AmplifyStaticWebsiteStack(app, 'S3AmplifyStaticWebsiteTest', {
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

  test('Amplify deploy handler has S3 read access for the CDK asset', () => {
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

  test('Custom resource for Amplify deployment is created via a Provider-backed Lambda', () => {
    // AmplifyDeployment is a plain CloudFormation custom resource whose ServiceToken
    // points at the cr.Provider's framework Lambda; the Provider framework in turn
    // invokes our own AmplifyDeployHandler function.
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
    template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      AppId: Match.anyValue(),
      BranchName: 'main',
    });
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
