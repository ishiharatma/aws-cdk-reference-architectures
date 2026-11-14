/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { EmulatorCompatAspect } from '@common/aspects/emulator-compat-aspect';
import { EventbridgeCustomBusStack } from 'lib/stacks/eventbridge-custom-bus-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envParams = params[Environment.TEST];
if (!envParams) {
  throw new Error('No parameters found for test environment');
}

/** Builds the stack inside a Stage, as bin/ does, optionally with the aspect on the Stage or the App. */
const build = (where: 'none' | 'stage' | 'app') => {
  const app = new cdk.App();
  const stage = new cdk.Stage(app, 'Stage', { env: testEnv });
  const stack = new EventbridgeCustomBusStack(stage, 'EventbridgeCustomBus', {
    project: 'test',
    environment: Environment.TEST,
    isAutoDeleteObject: true,
    env: testEnv,
    params: envParams,
  });
  if (where === 'stage') cdk.Aspects.of(stage).add(new EmulatorCompatAspect());
  if (where === 'app') cdk.Aspects.of(app).add(new EmulatorCompatAspect());
  return Template.fromStack(stack);
};

const types = (template: Template): string[] =>
  Object.values(template.toJSON().Resources as Record<string, any>).map((r) => r.Type);

const tlsDenyCount = (template: Template): number =>
  Object.values(template.findResources('AWS::SQS::QueuePolicy'))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
    .filter((s: any) => s.Effect === 'Deny' && s.Condition?.Bool?.['aws:SecureTransport'] === 'false').length;

describe('EmulatorCompatAspect', () => {
  const plain = build('none');
  const compat = build('stage');

  test('the unmodified stack contains everything the aspect rewrites', () => {
    expect(types(plain)).toEqual(expect.arrayContaining(['AWS::Logs::Delivery', 'Custom::CloudwatchLogResourcePolicy']));
    expect(tlsDenyCount(plain)).toBeGreaterThan(0);
  });

  test('removes vended log delivery resources AWS Emulator does not recognize', () => {
    expect(types(compat)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^AWS::Logs::Delivery(Source|Destination)?$/)]),
    );
  });

  test('removes custom resources but keeps their provider function', () => {
    expect(types(compat).filter((t) => t.startsWith('Custom::'))).toEqual([]);
    expect(Object.keys(compat.findResources('AWS::Lambda::Function')).length).toBe(
      Object.keys(plain.findResources('AWS::Lambda::Function')).length,
    );
  });

  test('strips only the aws:SecureTransport deny and keeps the EventBridge allow statements', () => {
    expect(tlsDenyCount(compat)).toBe(0);
    const allows = Object.values(compat.findResources('AWS::SQS::QueuePolicy'))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
      .filter((s: any) => s.Effect === 'Allow' && s.Principal?.Service === 'events.amazonaws.com');
    expect(allows.length).toBeGreaterThan(0);
  });

  test('leaves every other resource untouched', () => {
    const removed = ['AWS::Logs::Delivery', 'AWS::Logs::DeliverySource', 'AWS::Logs::DeliveryDestination'];
    const expected = types(plain).filter((t) => !removed.includes(t) && !t.startsWith('Custom::')).sort();
    expect(types(compat).sort()).toEqual(expected);
  });

  test('has no effect when added to the App instead of the Stage', () => {
    expect(build('app').toJSON()).toEqual(plain.toJSON());
  });

  test('removes a resource policy whose only statement is the aws:SecureTransport deny', () => {
    const stack = new cdk.Stack(new cdk.App(), 'Minimal');
    new sqs.Queue(stack, 'Queue', { enforceSSL: true });
    cdk.Aspects.of(stack).add(new EmulatorCompatAspect());
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::SQS::QueuePolicy', 0);
    template.resourceCountIs('AWS::SQS::Queue', 1);
  });

  test('honours opt-outs', () => {
    const stack = new cdk.Stack(new cdk.App(), 'OptOut');
    new sqs.Queue(stack, 'Queue', { enforceSSL: true });
    cdk.Aspects.of(stack).add(new EmulatorCompatAspect({ stripSecureTransportDeny: false }));
    Template.fromStack(stack).resourceCountIs('AWS::SQS::QueuePolicy', 1);
  });
});
