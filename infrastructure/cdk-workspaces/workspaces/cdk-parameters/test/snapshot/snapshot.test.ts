/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CdkTSParametersStack } from "lib/stacks/cdk-ts-parameters-stack";
import { CdkJsonParametersStack } from "lib/stacks/cdk-json-parameters-stack";
import { Environment } from 'lib/types/common';
import 'test/parameters';
import { params } from "parameters/environments";
import { baseContext } from "test/helpers/test-context";

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = "TestProject";
const envName: Environment = Environment.TEST;
if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];
const testJsonContext = {
  "test": {
    "vpcConfig": {
        "createConfig": {
          "vpcName": "TestVPC",
          "cidr": "10.100.0.0/16",
          "maxAzs": 2,
          "natCount": 1,
          "enableDnsHostnames": true,
          "enableDnsSupport": true,
          "subnets": [
            {
              "subnetType": "PUBLIC",
              "name": "Public",
              "cidrMask": 24
            },
            {
              "subnetType": "PRIVATE_WITH_NAT",
              "name": "Private",
              "cidrMask": 24
            }
          ]
        }
    }
  }
}
const testContext: Record<string, any> = {
  ...baseContext,
  ...testJsonContext,
};
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
  const app = new cdk.App({ context: testContext });
  cdk.Tags.of(app).add('Project', projectName);
  cdk.Tags.of(app).add('Environment', envName);

  // Create all stacks first before calling Template.fromStack()
  const stack = new CdkTSParametersStack(app, "CdkParameters", {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    terminationProtection: false,
    vpcConfig: envParams.vpcConfig,
  });

  const jsonParameterStack = new CdkJsonParametersStack(app, "CdkJsonParameters", {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    terminationProtection: false,
  });

  // Now get templates after all stacks are created
  const stackTemplate = Template.fromStack(stack);
  const jsonParameterStackTemplate = Template.fromStack(jsonParameterStack);

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
      expect(stackTemplate.toJSON()).toMatchSnapshot();
      expect(jsonParameterStackTemplate.toJSON()).toMatchSnapshot();
    });

    test("Resource types and counts: CdkTSParametersStack", () => {
      // Best practice: Track resource counts
      // Purpose: Detect unintended resource increases or decreases (to understand cost impact)
      const templateJson = stackTemplate.toJSON();
      const resourceCounts: Record<string, number> = {};
      
      Object.values(templateJson.Resources || {}).forEach((resource: any) => {
        const type = resource.Type;
        resourceCounts[type] = (resourceCounts[type] || 0) + 1;
      });

      expect(resourceCounts).toMatchSnapshot();
    });
    test("Resource types and counts: CdkJsonParametersStack", () => {
      // Best practice: Track resource counts
      // Purpose: Detect unintended resource increases or decreases (to understand cost impact)
      const templateJson = jsonParameterStackTemplate.toJSON();
      const resourceCounts: Record<string, number> = {};
      
      Object.values(templateJson.Resources || {}).forEach((resource: any) => {
        const type = resource.Type;
        resourceCounts[type] = (resourceCounts[type] || 0) + 1;
      });

      expect(resourceCounts).toMatchSnapshot();
    });
  });

});
