/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { Ec2DualEniStack } from 'lib/stacks/ec2-dual-eni-stack';
import { params } from 'parameters/environments';
import '../parameters';

const defaultEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'TestProject';
const envName: Environment = Environment.TEST;

if (!params[envName]) throw new Error(`No parameters found for environment: ${envName}`);
const envParams = params[envName]!;

function buildStack() {
  const app = new cdk.App();
  cdk.Tags.of(app).add('Project', projectName);
  cdk.Tags.of(app).add('Environment', envName);

  return new Ec2DualEniStack(app, 'Ec2DualEniStack', {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    terminationProtection: false,
    envParams,
    managementAllowedCidrs: ['203.0.113.0/24'],
    webAllowedCidrs: ['192.0.2.1/32'],
  });
}

describe('Stack Snapshot Tests', () => {
  const stack = buildStack();
  const t = Template.fromStack(stack);

  function resourceCounts(template: Template): Record<string, number> {
    const json = template.toJSON();
    const counts: Record<string, number> = {};
    Object.values(json.Resources || {}).forEach((r: any) => {
      counts[(r as any).Type] = (counts[(r as any).Type] || 0) + 1;
    });
    return counts;
  }

  test('full template snapshot', () => expect(t.toJSON()).toMatchSnapshot());
  test('resource counts', () => expect(resourceCounts(t)).toMatchSnapshot());
});
