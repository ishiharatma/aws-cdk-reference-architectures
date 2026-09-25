/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { DynamodbVectorSearchSemanticApiStack } from 'lib/stacks/dynamodb-vector-search-semantic-api-stack';
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
describe('DynamodbVectorSearchSemanticApiStack Snapshot', () => {
  const app = new cdk.App();
  const stack = new DynamodbVectorSearchSemanticApiStack(app, 'DynamodbVectorSearchSemanticApi', {
    project: projectName,
    environment: envName,
    isAutoDeleteObject: true,
    env: testEnv,
    params: envParams,
  });
  const stackTemplate = Template.fromStack(stack);

  test('Complete CloudFormation template snapshot', () => {
    const templateJson = JSON.parse(
      // Lambda asset hashes change with any bundle byte; normalise them so snapshots track infra, not bundler output.
      JSON.stringify(stackTemplate.toJSON()).replace(/"S3Key":"[0-9a-f]{64}\.zip"/g, '"S3Key":"<asset-hash>.zip"'),
    );
    expect(templateJson).toMatchSnapshot();
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
