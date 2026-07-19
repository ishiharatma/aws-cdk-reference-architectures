/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template } from "aws-cdk-lib/assertions";
import { Environment } from '@common/parameters/environments';
import { BaseStack } from "lib/stacks/base-stack";
import { EcrStack } from "lib/stacks/ecr-stack";
import { EcsFargateAlbStack } from "lib/stacks/ecs-fargate-alb-stack";
import { params } from "parameters/environments";
import '../parameters';
import * as path from 'path';
import { loadCdkContext } from '@common/test-helpers/test-context';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = "testproject";
const envName: Environment = Environment.TEST;

if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];
const cdkJsonPath = path.resolve(__dirname, "../../cdk.json");
const baseContext = loadCdkContext(cdkJsonPath);

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
  const context = {...baseContext, "aws:cdk:bundling-stacks": [],};
  const app = new cdk.App({ context });

  // Create base stack first
  const baseStack = new BaseStack(app, "Base", {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    config: envParams.vpcConfig,
    hostedZoneId: envParams.hostedZoneId,
    allowedIpsforAlb: ['0.0.0.0/0'],
    ports: [8080],
  });

  // Create ECR stack
  const ecrStack = new EcrStack(app, "Ecr", {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    config: envParams,
    isBootstrapMode: false,
    commitHash: 'snapshot-test',
  });

  // Create ECS Fargate ALB stack
  const ecsStack = new EcsFargateAlbStack(app, "EcsFargateAlb", {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    config: envParams,
    vpc: baseStack.vpc.vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    ecsSecurityGroups: [baseStack.ecsSecurityGroup],
    albSecurityGroup: baseStack.albSecurityGroup,
    repositories: ecrStack.repositories,
    commitHash: 'snapshot-test',
    isALBOpen: true,
  });

  describe("BaseStack Snapshot", () => {
    test("should match snapshot", () => {
      const stackTemplate = Template.fromStack(baseStack);
      expect(stackTemplate.toJSON()).toMatchSnapshot();
    });
  });

  describe("EcrStack Snapshot", () => {
    test("should match snapshot", () => {
      const stackTemplate = Template.fromStack(ecrStack);
      expect(stackTemplate.toJSON()).toMatchSnapshot();
    });
  });

  describe("EcsFargateAlbStack Snapshot", () => {
    test("should match snapshot", () => {
      const stackTemplate = Template.fromStack(ecsStack);
      expect(stackTemplate.toJSON()).toMatchSnapshot();
    });
  });

});
