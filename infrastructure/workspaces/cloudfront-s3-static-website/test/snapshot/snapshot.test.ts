/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Environment } from '@common/parameters/environments';
import { CloudfrontWafStack } from "lib/stacks/cloudfront-waf-stack";
import { CloudfrontS3StaticWebsiteStack } from "lib/stacks/cloudfront-s3-static-website-stack";
import { params } from "parameters/environments";
import '../parameters';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};
const wafEnv = {
    account: '123456789012',
    region: 'us-east-1',
};

const projectName = "TestProject";
const envName: Environment = Environment.TEST;

if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

// The real WAF Web ACL lives in a separate cross-region stack (see cloudfront-waf-stack.ts);
// the main stack only consumes its ARN, so a fixed string stands in for it here.
const fakeWebAclArn = 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/TestProject-test-WafAcl/11111111-1111-1111-1111-111111111111';

/**
 * AWS CDK Snapshot Test Suite
 *
 * Purpose of this test suite:
 * 1. Detect unintended changes in the entire CloudFormation template
 * 2. Ensure safety during refactoring
 * 3. Track changes in the number of resources
 *
 * How to use snapshot tests:
 * - On first run: A snapshot file is created
 * - On change detection: Differences are shown, update with --updateSnapshot if changes are intentional
 * - During refactoring: Ensure output remains the same
 *
 * Note: Detailed configuration value verification is done with unit tests (test/unit/)
 */
describe("Stack Snapshot Tests", () => {
  describe("CloudfrontWafStack", () => {
    const app = new cdk.App();
    const stack = new CloudfrontWafStack(app, "CloudfrontWaf", {
      project: projectName,
      environment: envName,
      env: wafEnv,
      isAutoDeleteObject: true,
      terminationProtection: false,
      enableWaf: true,
      allowedIpsAfterRules: ['192.0.2.10'],
    });
    const template = Template.fromStack(stack);
    cdk.Tags.of(app).add('Project', projectName);
    cdk.Tags.of(app).add('Environment', envName);

    afterAll(() => {
      app.node.children.forEach((child) => {
        if (child instanceof cdk.Stack) {
          child.node.tryRemoveChild("ResourceHandlerCustomResourceProvider");
        }
      });
    });

    test("Complete CloudFormation template snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    test("Resource types and counts", () => {
      const templateJson = template.toJSON();
      const resourceCounts: Record<string, number> = {};
      Object.values(templateJson.Resources || {}).forEach((resource: any) => {
        const type = resource.Type;
        resourceCounts[type] = (resourceCounts[type] || 0) + 1;
      });
      expect(resourceCounts).toMatchSnapshot();
    });
  });

  describe("CloudfrontS3StaticWebsiteStack", () => {
    const app = new cdk.App();
    const stack = new CloudfrontS3StaticWebsiteStack(app, "CloudfrontS3StaticWebsite", {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      terminationProtection: false,
      envParams,
      webAclArn: fakeWebAclArn,
    });
    const template = Template.fromStack(stack);
    cdk.Tags.of(app).add('Project', projectName);
    cdk.Tags.of(app).add('Environment', envName);

    afterAll(() => {
      app.node.children.forEach((child) => {
        if (child instanceof cdk.Stack) {
          child.node.tryRemoveChild("ResourceHandlerCustomResourceProvider");
        }
      });
    });

    test("Complete CloudFormation template snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    test("Resource types and counts", () => {
      const templateJson = template.toJSON();
      const resourceCounts: Record<string, number> = {};
      Object.values(templateJson.Resources || {}).forEach((resource: any) => {
        const type = resource.Type;
        resourceCounts[type] = (resourceCounts[type] || 0) + 1;
      });
      expect(resourceCounts).toMatchSnapshot();
    });
  });
});
