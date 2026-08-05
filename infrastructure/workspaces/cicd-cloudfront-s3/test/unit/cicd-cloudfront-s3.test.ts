import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { CicdCloudfrontS3Stack } from 'lib/stacks/cicd-cloudfront-s3-stack';
import { params, EnvParams } from 'parameters/environments';
import '../parameters';

const defaultEnv = {
  account: '123456789012',
  region: 'ap-northeast-1',
};

const projectName = 'testproject';
const envName: Environment = Environment.TEST;
if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

function synth(overrides: Partial<EnvParams> = {}, isAutoDeleteObject = true) {
  const app = new cdk.App();
  const stack = new CicdCloudfrontS3Stack(app, 'CicdCloudfrontS3', {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject,
    terminationProtection: false,
    envParams: { ...envParams, ...overrides },
  });
  return Template.fromStack(stack);
}

describe('CicdCloudfrontS3Stack core resources', () => {
  const template = synth();

  test('creates exactly one CodePipeline', () => {
    template.resourceCountIs('AWS::CodePipeline::Pipeline', 1);
  });

  test('creates exactly one CodeBuild project', () => {
    template.resourceCountIs('AWS::CodeBuild::Project', 1);
  });

  test('creates exactly three Lambda functions (S3 sync + CloudFront invalidation + the S3 auto-delete-objects custom resource handler)', () => {
    template.resourceCountIs('AWS::Lambda::Function', 3);
  });

  test('creates exactly one artifact S3 bucket (the deployment target bucket is imported, not created)', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
  });

  test('both application Lambda functions run on the Python 3.14 managed runtime', () => {
    const pythonFunctions = template.findResources('AWS::Lambda::Function', {
      Properties: Match.objectLike({
        Runtime: 'python3.14',
        Handler: 'index.handler',
      }),
    });
    expect(Object.keys(pythonFunctions)).toHaveLength(2);
  });

  test('pipeline stages run in the expected order without an Approval stage when no approval topic is configured', () => {
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Stages: Match.arrayEquals([
        Match.objectLike({ Name: 'Source' }),
        Match.objectLike({ Name: 'Build' }),
        Match.objectLike({ Name: 'Deploy' }),
        Match.objectLike({ Name: 'Sync' }),
        Match.objectLike({ Name: 'InvalidateCache' }),
      ]),
    });
  });

  test('the S3 sync Lambda is invoked with the deployment target bucket name', () => {
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Stages: Match.arrayWith([
        Match.objectLike({
          Name: 'Sync',
          Actions: Match.arrayWith([
            Match.objectLike({
              Configuration: Match.objectLike({
                UserParameters: JSON.stringify({
                  DEST_BUCKET_NAME: envParams.deploymentTargetBucketName,
                }),
              }),
            }),
          ]),
        }),
      ]),
    });
  });

  test('does not create a CodeStarNotifications rule when no approval topic is configured', () => {
    template.resourceCountIs('AWS::CodeStarNotifications::NotificationRule', 0);
  });

  test('the pipeline role does not grant the overly broad codedeploy:* permission', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const hasCodeDeployWildcard = Object.values(policies).some((policy) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((statement: { Action?: string | string[] }) => {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        return actions.includes('codedeploy:*');
      });
    });
    expect(hasCodeDeployWildcard).toBe(false);
  });

  test('tags the stack with repository, branch, and deployment target bucket', () => {
    // CloudFormation renders stack-level tags in alphabetical order by key.
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Tags: Match.arrayWith([
        { Key: 'Branch', Value: envParams.repositoryBranch },
        { Key: 'DeploymentTargetBucket', Value: envParams.deploymentTargetBucketName },
        { Key: 'Repository', Value: envParams.repositoryName },
      ]),
    });
  });
});

describe('CicdCloudfrontS3Stack with an approval topic configured', () => {
  const template = synth({ approvalTopicArn: 'arn:aws:sns:ap-northeast-1:123456789012:test-approvals' });

  test('inserts an Approval stage between Build and Deploy', () => {
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Stages: Match.arrayEquals([
        Match.objectLike({ Name: 'Source' }),
        Match.objectLike({ Name: 'Build' }),
        Match.objectLike({ Name: 'Approval' }),
        Match.objectLike({ Name: 'Deploy' }),
        Match.objectLike({ Name: 'Sync' }),
        Match.objectLike({ Name: 'InvalidateCache' }),
      ]),
    });
  });

  test('creates a CodeStarNotifications rule targeting the approval topic', () => {
    template.hasResourceProperties('AWS::CodeStarNotifications::NotificationRule', {
      Targets: [
        Match.objectLike({
          TargetAddress: 'arn:aws:sns:ap-northeast-1:123456789012:test-approvals',
        }),
      ],
    });
  });
});

describe('CicdCloudfrontS3Stack removal policy', () => {
  test('destroys and auto-deletes the artifact bucket when isAutoDeleteObject is true', () => {
    const template = synth({}, true);
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Delete',
    });
  });

  test('retains the artifact bucket when isAutoDeleteObject is false', () => {
    const template = synth({}, false);
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
    });
  });
});
