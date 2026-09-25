import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AppStage } from '../lib/app-stage';
import { APP_VERSION } from '../lib/config';

const synthStage = (stageName: string) => {
  const app = new cdk.App();
  const stage = new AppStage(app, stageName, { project: 'test', environment: 'test', stageName });
  const stack = stage.node.findChild('Hello') as cdk.Stack;
  return { stage, template: Template.fromStack(stack) };
};

describe('AppStage / HelloStack', () => {
  test('deploys one ARM64 Node.js 24 function that reports its stage and version', () => {
    const { template } = synthStage('Dev');
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'test-test-cdkp-dev-hello',
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      Environment: { Variables: { STAGE_NAME: 'Dev', APP_VERSION } },
    });
  });

  test('each stage gets its own physical names so Dev and Prod can coexist in one account', () => {
    const dev = synthStage('Dev').stage;
    const prod = synthStage('Prod').stage;
    expect(dev.functionName).not.toEqual(prod.functionName);
  });

  test('exposes the function name as an output for the pipeline smoke test', () => {
    const { template } = synthStage('Dev');
    expect(Object.keys(template.toJSON().Outputs)).toContain('FunctionName');
  });

  test('log group has retention and is destroyed with the stack', () => {
    const { template } = synthStage('Dev');
    template.hasResource('AWS::Logs::LogGroup', { Properties: { RetentionInDays: 7 }, DeletionPolicy: 'Delete' });
  });
});
