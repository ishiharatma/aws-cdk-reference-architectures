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
      expect(stackTemplate.toJSON()).toMatchSnapshot();
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
