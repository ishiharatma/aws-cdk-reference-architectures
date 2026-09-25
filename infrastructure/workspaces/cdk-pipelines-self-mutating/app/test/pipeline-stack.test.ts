/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ENABLE_SECURITY_CHECK } from '../lib/config';
import { PipelineStack } from '../lib/pipeline-stack';

const env = { account: '123456789012', region: 'ap-northeast-1' };

describe('PipelineStack', () => {
  let template: Template;
  let stages: any[];

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new PipelineStack(app, 'Pipeline', { project: 'test', environment: 'test', isAutoDeleteObject: true, env });
    template = Template.fromStack(stack);
    const pipeline = Object.values(template.findResources('AWS::CodePipeline::Pipeline'))[0] as any;
    stages = pipeline.Properties.Stages;
  });

  const actionNames = (stageName: string): string[] =>
    stages.find((s) => s.Name === stageName).Actions.map((a: any) => a.Name);

  test('is a V2 pipeline that restarts itself after self-mutation, without a cross-account KMS key', () => {
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      PipelineType: 'V2',
      RestartExecutionOnUpdate: true,
      Name: 'test-test-cdkp-pipeline',
    });
    template.resourceCountIs('AWS::KMS::Key', 0);
  });

  // CDK Pipelines only adds an `Assets` stage when a stack has file/Docker assets; this app's Lambda is inline.
  test('stage order is Source -> Build -> UpdatePipeline -> Dev -> Prod', () => {
    expect(stages.map((s) => s.Name)).toEqual(['Source', 'Build', 'UpdatePipeline', 'Dev', 'Prod']);
  });

  test('watches the CodeCommit repository derived from the naming convention', () => {
    const source = stages.find((s) => s.Name === 'Source').Actions[0];
    expect(source.ActionTypeId.Provider).toBe('CodeCommit');
    expect(source.Configuration.RepositoryName).toBe('test-test-cdkp-app');
    expect(source.Configuration.BranchName).toBe('main');
  });

  test('UpdatePipeline stage exists (self-mutation)', () => {
    expect(actionNames('UpdatePipeline')).toEqual(['SelfMutate']);
  });

  test('Dev is deployed then smoke-tested; Prod requires manual approval first', () => {
    const dev = actionNames('Dev');
    expect(dev.indexOf('SmokeTestDev')).toBeGreaterThan(dev.findIndex((n) => n.includes('Deploy')));
    const prod = actionNames('Prod');
    expect(prod[0]).toBe('PromoteToProd');
    const approval = stages.find((s) => s.Name === 'Prod').Actions[0];
    expect(approval.ActionTypeId.Category).toBe('Approval');
    expect(prod).toContain('SmokeTestProd');
  });

  // The pipeline's own structure follows lib/config.ts. Flipping the flag is how the check script
  // proves self-mutation, so this must hold for either value.
  test('Dev has a SecurityCheck pre-deployment step exactly when ENABLE_SECURITY_CHECK is set', () => {
    expect(actionNames('Dev').includes('SecurityCheck')).toBe(ENABLE_SECURITY_CHECK);
  });

  test('artifact bucket is private, TLS-only and encrypted', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: Match.anyValue(),
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]) },
    });
  });

  test('synth step type-checks, tests, then synthesizes with the baked-in project/env', () => {
    const projects = Object.values(template.findResources('AWS::CodeBuild::Project')) as any[];
    const specs = projects.map((p) => JSON.stringify(p.Properties.Source.BuildSpec ?? ''));
    const synth = specs.find((s) => s.includes('cdk synth'));
    expect(synth).toBeDefined();
    ['npm ci', 'npm run build', 'npm test', 'cdk synth -c project=test -c env=test'].forEach((c) => expect(synth).toContain(c));
  });

  test('smoke tests may only invoke their own stage function', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    const invoke = statements.filter((s: any) => s.Action === 'lambda:InvokeFunction');
    expect(invoke).toHaveLength(2);
    const resources = invoke.map((s: any) => JSON.stringify(s.Resource));
    expect(resources.some((r) => r.includes('test-test-cdkp-dev-hello'))).toBe(true);
    expect(resources.some((r) => r.includes('test-test-cdkp-prod-hello'))).toBe(true);
  });

  test('build logs go to a log group with retention', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  });
});
