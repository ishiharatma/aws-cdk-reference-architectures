/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { ApigwSinglePurposeLambdaStack } from 'lib/stacks/apigw-single-purpose-lambda-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'test';
const envName: Environment = Environment.TEST;

const envParams = params[envName];
if (!envParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

/**
 * AWS CDK Snapshot Test Suite
 *
 * 1. Detect unintended changes across the whole CloudFormation template
 * 2. Provide a safety net during refactoring
 * 3. Track changes in the number of resources
 *
 * Detailed property assertions live in test/unit/.
 */
describe('ApigwSinglePurposeLambdaStack Snapshot', () => {
  const app = new cdk.App();
  const stack = new ApigwSinglePurposeLambdaStack(app, 'ApigwSinglePurposeLambda', {
    project: projectName,
    environment: envName,
    isAutoDeleteObject: true,
    env: testEnv,
    params: envParams,
  });
  const stackTemplate = Template.fromStack(stack);

  test('Complete CloudFormation template snapshot', () => {
    expect(stackTemplate.toJSON()).toMatchSnapshot();
  });

  test('Resource types and counts', () => {
    const templateJson = stackTemplate.toJSON();
    const resourceCounts: Record<string, number> = {};
    Object.values(templateJson.Resources || {}).forEach((resource: any) => {
      resourceCounts[resource.Type] = (resourceCounts[resource.Type] || 0) + 1;
    });
    expect(resourceCounts).toMatchSnapshot();
  });
});
