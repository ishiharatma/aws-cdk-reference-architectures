/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { pascalCase } from "change-case-commonjs";
import { CdkJsonParametersStack } from "lib/stacks/cdk-json-parameters-stack";
import { Environment } from 'lib/types/common';
import 'test/parameters';
import { baseContext } from "test/helpers/test-context";

const defaultEnv = {
  account: "123456789012",
  region: "ap-northeast-1",
};

const projectName = "TestProject";
const envName: Environment = Environment.TEST;
const testJsonContext = {
  "test": {
    "vpcConfig": {
        "createConfig": {
          "vpcName": "TestVPC",
          "cidr": "10.1.0.0/16",
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
 * AWS CDK Unit Tests - Fine-grained Assertions
 *
 * This test suite aims to:
 * 1. Verify detailed configuration values of individual resources
 * 2. Check relationships between resources
 * 3. Validate security settings and cost optimization configurations
 *
 * Best practices for fine-grained assertions:
 * - Verify specific configuration values
 * - Name tests clearly to indicate their intent
 * - Test one aspect per test case
 */

describe("CdkJsonParametersStack Fine-grained Assertions", () => {
  let stackTemplate: Template;

  beforeAll(() => {
    const app = new cdk.App({ context: testContext });
    const stack = new CdkJsonParametersStack(app, "CdkJsonParameters", {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      terminationProtection: false,
    });
    stackTemplate = Template.fromStack(stack);
  });

  describe("VPC Resources", () => {
    test("should create 1 VPC", () => {
      stackTemplate.resourceCountIs("AWS::EC2::VPC", 1);
    });

    test("VPC should have correct CIDR block", () => {
      stackTemplate.hasResourceProperties("AWS::EC2::VPC", {
        CidrBlock: "10.1.0.0/16",
      });
    });

    test("VPC should have DNS support enabled", () => {
      stackTemplate.hasResourceProperties("AWS::EC2::VPC", {
        EnableDnsSupport: true,
        EnableDnsHostnames: true,
      });
    });

    test("VPC should have correct name tag", () => {
      const expectedVpcName = `${pascalCase(projectName)}/${pascalCase(envName)}/${pascalCase("TestVPC")}`;
      stackTemplate.hasResourceProperties("AWS::EC2::VPC", {
        Tags: [
          {
            Key: "Name",
            Value: expectedVpcName,
          },
        ],
      });
    });
  });

  describe("Subnet Configuration", () => {
    const expectedSubnets = [
        "Public",
        "Private",
    ];
    expectedSubnets.forEach((subnetName) => {
      test(`should create ${subnetName} Subnet`, () => {
        const allSubnets = stackTemplate.findResources("AWS::EC2::Subnet");
        const subnets = Object.values(allSubnets).filter((subnet: any) => {
          const tags = subnet.Properties?.Tags || [];
          return tags.some((tag: any) => 
            tag.Key === "aws-cdk:subnet-name" && tag.Value === subnetName
          );
        });
        expect(subnets.length).toBeGreaterThanOrEqual(1);
      });
    });

  });

  describe("NAT Gateways", () => {
    test("should create NAT Gateways", () => {
      // creates 1
      const natGateways = stackTemplate.findResources("AWS::EC2::NatGateway");
      expect(Object.keys(natGateways).length).toBeGreaterThanOrEqual(1);
    });

    test("NAT Gateway should have Elastic IP", () => {
      const natGateways = stackTemplate.findResources("AWS::EC2::NatGateway");
      const natGatewayWithEIP = Object.values(natGateways).filter((nat: any) =>
        nat.Properties?.AllocationId
      );
      expect(natGatewayWithEIP.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Internet Gateway", () => {
    test("should create Internet Gateways", () => {
      const igwCount = stackTemplate.findResources("AWS::EC2::InternetGateway");
      expect(Object.keys(igwCount).length).toBeGreaterThanOrEqual(1);
    });

    test("Internet Gateway should be attached to VPC", () => {
      const attachments = stackTemplate.findResources("AWS::EC2::VPCGatewayAttachment");
      expect(Object.keys(attachments).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Route Tables", () => {
    test("should create route tables for subnets", () => {
      const routeTables = stackTemplate.findResources("AWS::EC2::RouteTable");
      expect(Object.keys(routeTables).length).toBeGreaterThanOrEqual(1);
    });

    test("should have routes to Internet Gateway for public subnets", () => {
      const routes = stackTemplate.findResources("AWS::EC2::Route");
      const igwRoutes = Object.values(routes).filter((route: any) =>
        route.Properties?.GatewayId
      );
      expect(igwRoutes.length).toBeGreaterThanOrEqual(1);
    });

    test("should have routes to NAT Gateway for private subnets", () => {
      const routes = stackTemplate.findResources("AWS::EC2::Route");
      const natRoutes = Object.values(routes).filter((route: any) =>
        route.Properties?.NatGatewayId
      );
      expect(natRoutes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Elastic IPs", () => {
    test("should create Elastic IPs for NAT Gateways", () => {
      const eips = stackTemplate.findResources("AWS::EC2::EIP");
      expect(Object.keys(eips).length).toBeGreaterThanOrEqual(1);
    });

    test("Elastic IPs should have correct domain", () => {
      stackTemplate.hasResourceProperties("AWS::EC2::EIP", {
        Domain: "vpc",
      });
    });
  });
});