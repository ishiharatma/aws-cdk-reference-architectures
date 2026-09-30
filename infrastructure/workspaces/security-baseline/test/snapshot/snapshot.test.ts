/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { SecurityBaselineStack } from 'lib/stacks/security-baseline-stack';
import { params } from 'parameters/environments';
import '../parameters';

const defaultEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envName: Environment = Environment.TEST;
const envParams = params[envName];
if (!envParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

/**
 * Snapshot tests: detect unintended changes to the whole template and to resource counts.
 * Detailed property checks live in test/unit.
 */
describe('Stack Snapshot Tests', () => {
  const app = new cdk.App();
  const stack = new SecurityBaselineStack(app, 'SecurityBaseline', {
    project: 'TestProject',
    environment: envName,
    isAutoDeleteObject: true,
    env: defaultEnv,
    params: envParams,
  });
  const template = Template.fromStack(stack);

  test('Complete CloudFormation template snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });

  test('Resource types and counts', () => {
    const counts: Record<string, number> = {};
    Object.values(template.toJSON().Resources || {}).forEach((resource: any) => {
      counts[resource.Type] = (counts[resource.Type] || 0) + 1;
    });
    expect(counts).toMatchSnapshot();
  });
});
