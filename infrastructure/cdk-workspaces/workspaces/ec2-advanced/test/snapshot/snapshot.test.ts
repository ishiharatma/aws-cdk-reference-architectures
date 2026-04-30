/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { BaseStack } from 'lib/stacks/base-stack';
import { Ec2SingleStack } from 'lib/stacks/ec2-single-stack';
import { Ec2AutoRecoveryStack } from 'lib/stacks/ec2-auto-recovery-stack';
import { Ec2AsgSingleStack } from 'lib/stacks/ec2-asg-single-stack';
import { Ec2AsgMultiStack } from 'lib/stacks/ec2-asg-multi-stack';
import { params } from 'parameters/environments';
import '../parameters';

const defaultEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'TestProject';
const envName: Environment = Environment.TEST;

if (!params[envName]) throw new Error(`No parameters found for environment: ${envName}`);
const envParams = params[envName]!;

function buildStacks() {
  const app = new cdk.App();
  cdk.Tags.of(app).add('Project', projectName);
  cdk.Tags.of(app).add('Environment', envName);

  const base = new BaseStack(app, 'BaseStack', {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    config: envParams.vpcConfig,
  });

  const single = new Ec2SingleStack(app, 'Ec2SingleStack', {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    vpc: base.vpc,
    ec2Config: envParams.ec2Config,
  });

  const autoRecovery = new Ec2AutoRecoveryStack(app, 'Ec2AutoRecoveryStack', {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    vpc: base.vpc,
    ec2Config: envParams.ec2Config,
  });

  const asgSingle = new Ec2AsgSingleStack(app, 'Ec2AsgSingleStack', {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    vpc: base.vpc,
    ec2Config: envParams.ec2Config,
    ports: envParams.ports,
    allowedIpsforAlb: ['203.0.113.0/24'],
  });

  const asgMulti = new Ec2AsgMultiStack(app, 'Ec2AsgMultiStack', {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    vpc: base.vpc,
    ec2Config: envParams.ec2Config,
    ports: envParams.ports,
    allowedIpsforAlb: ['203.0.113.0/24'],
  });

  return { base, single, autoRecovery, asgSingle, asgMulti };
}

describe('Stack Snapshot Tests', () => {
  const stacks = buildStacks();

  function resourceCounts(template: Template): Record<string, number> {
    const json = template.toJSON();
    const counts: Record<string, number> = {};
    Object.values(json.Resources || {}).forEach((r: any) => {
      counts[r.Type] = (counts[r.Type] || 0) + 1;
    });
    return counts;
  }

  describe('Ec2SingleStack', () => {
    const t = Template.fromStack(stacks.single);
    test('full template snapshot', () => expect(t.toJSON()).toMatchSnapshot());
    test('resource counts', () => expect(resourceCounts(t)).toMatchSnapshot());
  });

  describe('Ec2AutoRecoveryStack', () => {
    const t = Template.fromStack(stacks.autoRecovery);
    test('full template snapshot', () => expect(t.toJSON()).toMatchSnapshot());
    test('resource counts', () => expect(resourceCounts(t)).toMatchSnapshot());
  });

  describe('Ec2AsgSingleStack', () => {
    const t = Template.fromStack(stacks.asgSingle);
    test('full template snapshot', () => expect(t.toJSON()).toMatchSnapshot());
    test('resource counts', () => expect(resourceCounts(t)).toMatchSnapshot());
  });

  describe('Ec2AsgMultiStack', () => {
    const t = Template.fromStack(stacks.asgMulti);
    test('full template snapshot', () => expect(t.toJSON()).toMatchSnapshot());
    test('resource counts', () => expect(resourceCounts(t)).toMatchSnapshot());
  });
});
