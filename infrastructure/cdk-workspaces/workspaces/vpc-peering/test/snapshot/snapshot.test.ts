/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Environment } from '@common/parameters/environments';
import { VpcAStack } from "lib/stacks/vpc-a-stack";
import { VpcCStack } from 'lib/stacks/vpc-c-stack';
import { CrossAccountPeeringStack } from 'lib/stacks/cross-account-peering-stack';
import { VpcCRoutesStack } from "lib/stacks/vpc-c-routes-stack";
import { params } from "parameters/environments";
import '../parameters';

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
  cdk.Tags.of(app).add('Project', projectName);
  cdk.Tags.of(app).add('Environment', envName);

  const vpcAStack = new VpcAStack(app, "VpcA", {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    terminationProtection: false,
    params: envParams,
  });
  const vpcCStack = new VpcCStack(app, "VpcC", {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    terminationProtection: false,
    params: envParams,
  });
  const crossAccountPeeringStack = new CrossAccountPeeringStack(app, "CrossAccountPeeringStack", {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    params: envParams,
    terminationProtection: false,
    requestorVpc: vpcAStack.vpcB.vpc,
    requestorVpcCidr: envParams.vpcBConfig.createConfig?.cidr || '10.1.0.0/16',
    peeringVpcCidr: envParams.vpcCConfig?.createConfig?.cidr || '10.2.0.0/16',
    peeringRoleName: 'VpcPeeringAcceptRole',
  });
  const vpcCRoutesStack = new VpcCRoutesStack(app, "VpcCRoutesStack", {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    terminationProtection: false,
    vpc: vpcCStack.vpcC.vpc,
    vpcBCidr: vpcAStack.vpcB.vpc.vpcCidrBlock,
    peeringIdParamName: `/${projectName}/${envName}/peering/vpc-b-vpc-c/id`,
    params: envParams,
  });

  const vpcAStackTemplate = Template.fromStack(vpcAStack);
  const vpcCStackTemplate = Template.fromStack(vpcCStack);
  const crossAccountPeeringStackTemplate = Template.fromStack(crossAccountPeeringStack);
  const vpcCRoutesStackTemplate = Template.fromStack(vpcCRoutesStack);

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
      expect(vpcAStackTemplate.toJSON()).toMatchSnapshot();
      expect(vpcCStackTemplate.toJSON()).toMatchSnapshot();
      expect(crossAccountPeeringStackTemplate.toJSON()).toMatchSnapshot();
      expect(vpcCRoutesStackTemplate.toJSON()).toMatchSnapshot();
    });

    test("Resource types and counts: VpcPeeringStack", () => {
      // Best practice: Track resource counts
      // Purpose: Detect unintended resource increases or decreases (to understand cost impact)
      const templateJson = vpcAStackTemplate.toJSON();
      const resourceCounts: Record<string, number> = {};
      
      Object.values(templateJson.Resources || {}).forEach((resource: any) => {
        const type = resource.Type;
        resourceCounts[type] = (resourceCounts[type] || 0) + 1;
      });

      expect(resourceCounts).toMatchSnapshot();
    });
    test("Resource types and counts: VpcCStack", () => {
      // Best practice: Track resource counts
      // Purpose: Detect unintended resource increases or decreases (to understand cost impact)
      const templateJson = vpcCStackTemplate.toJSON();
      const resourceCounts: Record<string, number> = {};
      
      Object.values(templateJson.Resources || {}).forEach((resource: any) => {
        const type = resource.Type;
        resourceCounts[type] = (resourceCounts[type] || 0) + 1;
      });

      expect(resourceCounts).toMatchSnapshot();
    });
    test("Resource types and counts: CrossAccountPeeringStack", () => {
      // Best practice: Track resource counts
      // Purpose: Detect unintended resource increases or decreases (to understand cost impact)
      const templateJson = crossAccountPeeringStackTemplate.toJSON();
      const resourceCounts: Record<string, number> = {};
      
      Object.values(templateJson.Resources || {}).forEach((resource: any) => {
        const type = resource.Type;
        resourceCounts[type] = (resourceCounts[type] || 0) + 1;
      });

      expect(resourceCounts).toMatchSnapshot();
    });
    test("Resource types and counts: VpcCRoutesStack", () => {
      // Best practice: Track resource counts
      // Purpose: Detect unintended resource increases or decreases (to understand cost impact)
      const templateJson = vpcCRoutesStackTemplate.toJSON();
      const resourceCounts: Record<string, number> = {};
      
      Object.values(templateJson.Resources || {}).forEach((resource: any) => {
        const type = resource.Type;
        resourceCounts[type] = (resourceCounts[type] || 0) + 1;
      });

      expect(resourceCounts).toMatchSnapshot();
    });
  });

});
