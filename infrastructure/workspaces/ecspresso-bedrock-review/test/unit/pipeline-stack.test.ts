import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import { Environment } from '@common/parameters/environments';
import { PipelineStack } from 'lib/stacks/pipeline-stack';
import {
  testEnvParams,
  testEnvParamsWithApproval,
  testEnvParamsWithAutoScaling,
  testSharedParams,
} from 'test/parameters/test-params';

/** A fixed-ARN CodeCommit repository stand-in, since PipelineStack takes the repository by reference. */
function testRepository(scope: cdk.App): codecommit.IRepository {
  const holder = new cdk.Stack(scope, 'RepoHolder', { env: { account: '111111111111', region: 'ap-northeast-1' } });
  return codecommit.Repository.fromRepositoryArn(
    holder,
    'Repo',
    'arn:aws:codecommit:ap-northeast-1:111111111111:ecspresso-bedrock-review-app'
  );
}

describe('PipelineStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new PipelineStack(app, 'TestPipeline', {
      env: { account: '111111111111', region: 'ap-northeast-1' },
      isAutoDeleteObject: true,
      project: 'testproject',
      environment: Environment.DEVELOPMENT,
      sharedParams: testSharedParams,
      envParams: testEnvParams,
      repository: testRepository(app),
    });
    template = Template.fromStack(stack);
  });

  test('creates exactly one CodePipeline', () => {
    template.resourceCountIs('AWS::CodePipeline::Pipeline', 1);
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'testproject-dev-pipeline',
    });
  });

  test('creates Test/Build/AgenticReview/Deploy CodeBuild projects (no Approve without requireManualApproval)', () => {
    template.resourceCountIs('AWS::CodeBuild::Project', 4);
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Stages: Match.arrayWith([
        Match.objectLike({ Name: 'AgenticReview' }),
      ]),
    });
    const stages = template.findResources('AWS::CodePipeline::Pipeline');
    const pipeline = Object.values(stages)[0].Properties.Stages as { Name: string }[];
    expect(pipeline.map((s) => s.Name)).toEqual(['Source', 'Test', 'Build', 'AgenticReview', 'Deploy']);
  });

  test('AgenticReview CodeBuild project gets BEDROCK_MODEL_ID / RISK_THRESHOLD env vars and bedrock:InvokeModel permission', () => {
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Name: 'testproject-dev-agentic-review',
      Environment: Match.objectLike({
        EnvironmentVariables: Match.arrayWith([
          Match.objectLike({ Name: 'BEDROCK_MODEL_ID', Value: 'anthropic.claude-3-5-sonnet-20241022-v2:0' }),
          Match.objectLike({ Name: 'RISK_THRESHOLD', Value: 'high' }),
        ]),
      }),
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowBedrockInvoke',
            Action: 'bedrock:InvokeModel',
          }),
        ]),
      },
    });
  });

  test('Build CodeBuild project defaults SECURITYHUB_IMPORT_ENABLED to false and gets BatchImportFindings permission', () => {
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Name: 'testproject-dev-build',
      Environment: Match.objectLike({
        EnvironmentVariables: Match.arrayWith([
          Match.objectLike({ Name: 'SECURITYHUB_IMPORT_ENABLED', Value: 'false' }),
        ]),
      }),
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowSecurityHubBatchImportFindings',
            Action: 'securityhub:BatchImportFindings',
          }),
        ]),
      },
    });
  });

  test('SSM parameters for ECS cluster/service placeholders are created', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/testproject/dev/ecs/cluster-name',
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/testproject/dev/ecs/service-name',
    });
  });

  test('Deploy CodeBuild project defaults AUTO_SCALING_ENABLED to false', () => {
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Name: 'testproject-dev-deploy',
      Environment: Match.objectLike({
        EnvironmentVariables: Match.arrayWith([
          Match.objectLike({ Name: 'AUTO_SCALING_ENABLED', Value: 'false' }),
        ]),
      }),
    });
  });
});

describe('PipelineStack — autoScalingEnabled', () => {
  test('passes AUTO_SCALING_ENABLED=true to the Deploy CodeBuild project', () => {
    const app = new cdk.App();
    const stack = new PipelineStack(app, 'TestPipelineAutoScaling', {
      env: { account: '111111111111', region: 'ap-northeast-1' },
      isAutoDeleteObject: true,
      project: 'testproject',
      environment: Environment.DEVELOPMENT,
      sharedParams: testSharedParams,
      envParams: testEnvParamsWithAutoScaling,
      repository: testRepository(app),
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Name: 'testproject-dev-deploy',
      Environment: Match.objectLike({
        EnvironmentVariables: Match.arrayWith([
          Match.objectLike({ Name: 'AUTO_SCALING_ENABLED', Value: 'true' }),
        ]),
      }),
    });
  });
});

describe('PipelineStack — requireManualApproval', () => {
  test('inserts an Approve stage before Deploy', () => {
    const app = new cdk.App();
    const stack = new PipelineStack(app, 'TestPipelineApprove', {
      env: { account: '111111111111', region: 'ap-northeast-1' },
      isAutoDeleteObject: true,
      project: 'testproject',
      environment: Environment.DEVELOPMENT,
      sharedParams: testSharedParams,
      envParams: testEnvParamsWithApproval,
      repository: testRepository(app),
    });
    const template = Template.fromStack(stack);
    const stages = template.findResources('AWS::CodePipeline::Pipeline');
    const pipeline = Object.values(stages)[0].Properties.Stages as { Name: string }[];
    expect(pipeline.map((s) => s.Name)).toEqual(['Source', 'Test', 'Build', 'AgenticReview', 'Approve', 'Deploy']);
  });
});
