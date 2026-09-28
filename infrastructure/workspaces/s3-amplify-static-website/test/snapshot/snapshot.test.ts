/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { S3AmplifyStaticWebsiteStack } from 'lib/stacks/s3-amplify-static-website-stack';

const defaultEnv = {
  account: '123456789012',
  region: 'ap-northeast-1',
};

const projectName = 'TestProject';
const envName: Environment = Environment.TEST;

describe('Stack Snapshot Tests', () => {
  const app = new cdk.App();

  const stack = new S3AmplifyStaticWebsiteStack(app, 'S3AmplifyStaticWebsite', {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    terminationProtection: false,
  });
  const stackTemplate = Template.fromStack(stack);
  cdk.Tags.of(app).add('Project', projectName);
  cdk.Tags.of(app).add('Environment', envName);

  describe('CloudFormation Template Snapshots', () => {
    test('Complete CloudFormation template snapshot', () => {
      const templateJson = JSON.parse(
        // Lambda asset hashes change with any bundle byte (including the inline
        // source map's embedded path, which varies by checkout location); normalize
        // them so snapshots track infra, not bundler/environment output.
        JSON.stringify(stackTemplate.toJSON()).replace(/"S3Key":"[0-9a-f]{64}\.zip"/g, '"S3Key":"<asset-hash>.zip"'),
      );
      expect(templateJson).toMatchSnapshot();
    });

    test('Resource types and counts', () => {
      const templateJson = stackTemplate.toJSON();
      const resourceCounts: Record<string, number> = {};

      Object.values(templateJson.Resources || {}).forEach((resource: any) => {
        const type = resource.Type;
        resourceCounts[type] = (resourceCounts[type] || 0) + 1;
      });

      expect(resourceCounts).toMatchSnapshot();
    });
  });
});
