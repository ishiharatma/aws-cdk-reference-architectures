/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { CognitoApigwAuthStack } from 'lib/stacks/cognito-apigw-auth-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envName: Environment = Environment.TEST;
const envParams = params[envName];
if (!envParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

/** Full-template and resource-count snapshots; Lambda asset hashes are normalised (bundler output). */
describe('CognitoApigwAuthStack Snapshot', () => {
  const app = new cdk.App();
  const stack = new CognitoApigwAuthStack(app, 'CognitoApigwAuth', {
    project: 'test',
    environment: envName,
    isAutoDeleteObject: true,
    env: testEnv,
    params: envParams,
  });
  const stackTemplate = Template.fromStack(stack);

  test('Complete CloudFormation template snapshot', () => {
    const json = JSON.parse(JSON.stringify(stackTemplate.toJSON()).replace(/"S3Key":"[0-9a-f]{64}\.zip"/g, '"S3Key":"<asset-hash>.zip"'));
    expect(json).toMatchSnapshot();
  });

  test('Resource types and counts', () => {
    const counts: Record<string, number> = {};
    Object.values(stackTemplate.toJSON().Resources || {}).forEach((r: any) => {
      counts[r.Type] = (counts[r.Type] || 0) + 1;
    });
    expect(counts).toMatchSnapshot();
  });
});
