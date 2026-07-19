/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Environment } from '@common/parameters/environments';
import { VpcCDKDefaultStack } from "lib/stacks/vpc-cdkdefault-stack";
import { VpcBasicsStack } from "lib/stacks/vpc-basics-stack";

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = "TestProject";
const envName: Environment = Environment.TEST;

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
  const app = new cdk.App();

  // Add tags before creating stacks
  cdk.Tags.of(app).add('Project', projectName);
  cdk.Tags.of(app).add('Environment', envName);

  const cdkDefaultStack = new VpcCDKDefaultStack(app, "VpcCDKDefault", {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    terminationProtection: false,
  });

  const vpcBasicsStack = new VpcBasicsStack(app, "VpcBasics", {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    terminationProtection: false,
  });

  const cdkDefaultStackTemplate = Template.fromStack(cdkDefaultStack);
  const vpcBasicsStackTemplate = Template.fromStack(vpcBasicsStack);

  // Cleanup after the entire test suite
  afterAll(() => {
    app.node.children.forEach((child) => {
      if (child instanceof cdk.Stack) {
        child.node.tryRemoveChild("ResourceHandlerCustomResourceProvider");
      }
    });
  });

  describe("CloudFormation Template Snapshots", () => {
    test("Complete CloudFormation template snapshot", () => {
      // Best practice: Complete template snapshot
      // Purpose: Detect significant changes, ensure safety during refactoring
      expect(vpcBasicsStackTemplate.toJSON()).toMatchSnapshot();
      expect(cdkDefaultStackTemplate.toJSON()).toMatchSnapshot();
    });

    test("CDKDefaultStack Resource types and counts", () => {
      // Best practice: Track resource counts
      // Purpose: Detect unintended resource increases or decreases (to understand cost impact)
      const cdkDefaultStackTemplateJson = cdkDefaultStackTemplate.toJSON();
      const resourceCounts: Record<string, number> = {};
      
      Object.values(cdkDefaultStackTemplateJson.Resources || {}).forEach((resource: any) => {
        const type = resource.Type;
        resourceCounts[type] = (resourceCounts[type] || 0) + 1;
      });

      expect(resourceCounts).toMatchSnapshot();
    });
    test("VpcBasicsStack Resource types and counts", () => {
      // Best practice: Track resource counts
      // Purpose: Detect unintended resource increases or decreases (to understand cost impact)
      const vpcBasicsStackTemplateJson = vpcBasicsStackTemplate.toJSON();
      const resourceCounts: Record<string, number> = {};
      
      Object.values(vpcBasicsStackTemplateJson.Resources || {}).forEach((resource: any) => {
        const type = resource.Type;
        resourceCounts[type] = (resourceCounts[type] || 0) + 1;
      });

      expect(resourceCounts).toMatchSnapshot();
    });
  });

});
