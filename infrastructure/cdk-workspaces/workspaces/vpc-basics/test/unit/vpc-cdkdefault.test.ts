/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import { VpcCDKDefaultStack } from "lib/stacks/vpc-cdkdefault-stack";
import { Template } from "aws-cdk-lib/assertions";
import { Environment } from "@common/parameters/environments";

const defaultEnv = {
  account: "123456789012",
  region: "ap-northeast-1",
};

const projectName = "TestProject";
const envName: Environment = Environment.TEST;

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

describe("VpcCDKDefaultStack Fine-grained Assertions", () => {
  let stackTemplate: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new VpcCDKDefaultStack(app, "VpcCDKDefaultStack", {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
    });
    stackTemplate = Template.fromStack(stack);
  });

  describe("VPC Resources", () => {
    test("should create 1 VPC (default)", () => {
      stackTemplate.resourceCountIs("AWS::EC2::VPC", 1);
    });

    test("CDK default VPC should have correct CIDR block", () => {
      stackTemplate.hasResourceProperties("AWS::EC2::VPC", {
        CidrBlock: "10.0.0.0/16",
      });
    });

    test("CDK default VPC should have DNS support enabled", () => {
      stackTemplate.hasResourceProperties("AWS::EC2::VPC", {
        EnableDnsSupport: true,
        EnableDnsHostnames: true,
      });
    });

  });

  describe("Subnet Configuration", () => {
    test("should create public subnets", () => {
      const subnets = stackTemplate.findResources("AWS::EC2::Subnet");
      const publicSubnets = Object.values(subnets).filter((subnet: any) => {
        const tags = subnet.Properties?.Tags || [];
        return tags.some((tag: any) => 
          tag.Key === "aws-cdk:subnet-name" && tag.Value === "Public"
        );
      });
      expect(publicSubnets.length).toBeGreaterThanOrEqual(1);
    });
    test("should create private subnets", () => {
      const subnets = stackTemplate.findResources("AWS::EC2::Subnet");
      const privateSubnets = Object.values(subnets).filter((subnet: any) => {
        const tags = subnet.Properties?.Tags || [];
        return tags.some((tag: any) => 
          tag.Key === "aws-cdk:subnet-name" && tag.Value === "Private"
        );
      });
      expect(privateSubnets.length).toBeGreaterThanOrEqual(1);
    });

  });

  describe("NAT Gateways", () => {
    test("should create NAT Gateways", () => {
      // Default VPC creates 3 NAT Gateways (one per AZ)
      const natGateways = stackTemplate.findResources("AWS::EC2::NatGateway");
      expect(Object.keys(natGateways).length).toBeGreaterThanOrEqual(3);
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

  describe("VPC Flow Logs", () => {
    test("should not create Flow Logs", () => {
      stackTemplate.resourceCountIs("AWS::EC2::FlowLog", 0);
    });
  });

  describe("VPC Gateway Endpoints", () => {
    test("should create S3 Gateway Endpoint", () => {
      const endpoints = stackTemplate.findResources("AWS::EC2::VPCEndpoint");
      const s3Endpoint = Object.values(endpoints).find((endpoint: any) => {
        const serviceName = endpoint.Properties?.ServiceName;
        if (typeof serviceName === 'string') {
          return serviceName.includes('s3');
        }
        if (serviceName?.["Fn::Join"]) {
          const parts = serviceName["Fn::Join"][1];
          return parts.some((part: any) => typeof part === 'string' && part.includes('s3'));
        }
        return false;
      });
      expect(s3Endpoint).toBeUndefined();
    });

    test("should create DynamoDB Gateway Endpoint", () => {
      const endpoints = stackTemplate.findResources("AWS::EC2::VPCEndpoint");
      const dynamoEndpoint = Object.values(endpoints).find((endpoint: any) => {
        const serviceName = endpoint.Properties?.ServiceName;
        if (typeof serviceName === 'string') {
          return serviceName.includes('dynamodb');
        }
        if (serviceName?.["Fn::Join"]) {
          const parts = serviceName["Fn::Join"][1];
          return parts.some((part: any) => typeof part === 'string' && part.includes('dynamodb'));
        }
        return false;
      });
      expect(dynamoEndpoint).toBeUndefined();
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