/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { RepositoryStack } from 'lib/stacks/repository-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envName: Environment = Environment.TEST;
const envParams = params[envName];
if (!envParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

/**
 * The repository's initial commit is an S3 asset of `app/`, so its hash changes with every edit to
 * the app. Normalise it so the snapshot tracks infrastructure, not app content.
 */
const normalise = (template: unknown) =>
  JSON.parse(
    JSON.stringify(template)
      .replace(/[0-9a-f]{64}\.zip/g, '<asset-hash>.zip')
      .replace(/"AssetParameters[0-9a-f]{64}[A-Za-z0-9]*"/g, '"<asset-parameter>"'),
  );

describe('RepositoryStack Snapshot', () => {
  const app = new cdk.App();
  const stack = new RepositoryStack(app, 'Repository', {
    project: 'test',
    environment: envName,
    isAutoDeleteObject: true,
    env: testEnv,
    params: envParams,
  });
  const stackTemplate = Template.fromStack(stack);

  test('Complete CloudFormation template snapshot', () => {
    expect(normalise(stackTemplate.toJSON())).toMatchSnapshot();
  });

  test('Resource types and counts', () => {
    const resourceCounts: Record<string, number> = {};
    Object.values(stackTemplate.toJSON().Resources || {}).forEach((resource: any) => {
      resourceCounts[resource.Type] = (resourceCounts[resource.Type] || 0) + 1;
    });
    expect(resourceCounts).toMatchSnapshot();
  });
});
