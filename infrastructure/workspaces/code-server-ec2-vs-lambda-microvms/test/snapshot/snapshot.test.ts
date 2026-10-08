/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { CodeServerEc2Stack } from 'lib/stacks/code-server-ec2-stack';
import { CodeServerMicrovmsStack } from 'lib/stacks/code-server-microvms-stack';
import { params } from 'parameters/environments';
import '../parameters';

const env = { account: '123456789012', region: 'ap-northeast-1' };
const envParams = params[Environment.TEST];
if (!envParams) {
  throw new Error('No parameters found for the test environment');
}
const props = { project: 'test', environment: Environment.TEST, isAutoDeleteObject: true, env, params: envParams };

const countResources = (template: Template): Record<string, number> => {
  const counts: Record<string, number> = {};
  Object.values(template.toJSON().Resources || {}).forEach((r: any) => {
    counts[r.Type] = (counts[r.Type] || 0) + 1;
  });
  return counts;
};

describe.each([
  ['Ec2', (app: cdk.App) => new CodeServerEc2Stack(app, 'Ec2', props)],
  ['Microvms', (app: cdk.App) => new CodeServerMicrovmsStack(app, 'Microvms', props)],
])('%s stack snapshots', (_name, create) => {
  const template = Template.fromStack(create(new cdk.App()));

  test('Complete CloudFormation template snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });

  test('Resource types and counts', () => {
    expect(countResources(template)).toMatchSnapshot();
  });
});
