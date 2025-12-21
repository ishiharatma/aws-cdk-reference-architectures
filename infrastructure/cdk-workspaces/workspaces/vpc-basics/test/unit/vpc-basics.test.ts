/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import { VpcBasicsStack } from "lib/stacks/vpc-basics-stack";
import { Template } from "aws-cdk-lib/assertions";
import { Environment } from "@common/parameters/environments";
import { pascalCase } from "change-case-commonjs";

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

describe("VpcBasicsStack Fine-grained Assertions", () => {
  let stackTemplate: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new VpcBasicsStack(app, "VpcBasicsStack", {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
    });
    stackTemplate = Template.fromStack(stack);
  });

  describe("VPC Resources", () => {
    test("should create 1 VPC", () => {
      stackTemplate.resourceCountIs("AWS::EC2::VPC", 1);
    });

    test("custom VPC should have correct CIDR block", () => {
      stackTemplate.hasResourceProperties("AWS::EC2::VPC", {
        CidrBlock: "10.1.0.0/16",
      });
    });

    test("custom VPC should have DNS support enabled", () => {
      stackTemplate.hasResourceProperties("AWS::EC2::VPC", {
        EnableDnsSupport: true,
        EnableDnsHostnames: true,
      });
    });

    test("custom VPC should have correct name tag", () => {
      const expectedVpcName = `${pascalCase(projectName)}/${pascalCase(envName)}/CustomVPC`;
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
    const subnets = [
        "External",
        "Management",
        "Internal",
        "Application",
        "Isolated",
        "TransitGateway"
    ];
    subnets.forEach((subnetName) => {
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

  describe("VPC Flow Logs", () => {
    test("should create Flow Logs", () => {
      stackTemplate.resourceCountIs("AWS::EC2::FlowLog", 2);
    });

    test("should have Flow Log to S3 with ALL traffic", () => {
      stackTemplate.hasResourceProperties("AWS::EC2::FlowLog", {
        ResourceType: "VPC",
        TrafficType: "ALL",
        LogDestinationType: "s3",
      });
    });

    test("should have Flow Log to CloudWatch Logs with REJECT traffic", () => {
      stackTemplate.hasResourceProperties("AWS::EC2::FlowLog", {
        ResourceType: "VPC",
        TrafficType: "REJECT",
        LogDestinationType: "cloud-watch-logs",
      });
    });
  });

  describe("CloudWatch Logs", () => {
    test("should create log group for Flow Logs", () => {
      stackTemplate.resourceCountIs("AWS::Logs::LogGroup", 1);
    });

    test("log group should have 1 week retention", () => {
      stackTemplate.hasResourceProperties("AWS::Logs::LogGroup", {
        RetentionInDays: 7,
      });
    });

    test("log group should have DESTROY removal policy", () => {
      const logGroups = stackTemplate.findResources("AWS::Logs::LogGroup");
      const logGroup = Object.values(logGroups)[0] as any;
      expect(logGroup.DeletionPolicy).toBe("Delete");
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
      expect(s3Endpoint).toBeDefined();
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
      expect(dynamoEndpoint).toBeDefined();
    });

    test("Gateway Endpoints should be attached to private subnets", () => {
      const endpoints = stackTemplate.findResources("AWS::EC2::VPCEndpoint");
      const gatewayEndpoints = Object.values(endpoints).filter((endpoint: any) =>
        endpoint.Properties?.VpcEndpointType === "Gateway"
      );
      gatewayEndpoints.forEach((endpoint: any) => {
        expect(endpoint.Properties?.RouteTableIds).toBeDefined();
        expect(Array.isArray(endpoint.Properties?.RouteTableIds)).toBe(true);
      });
    });
  });

  describe("VPC Interface Endpoints", () => {
    test("should create SSM Interface Endpoint", () => {
      const endpoints = stackTemplate.findResources("AWS::EC2::VPCEndpoint");
      const ssmEndpoint = Object.values(endpoints).find((endpoint: any) => {
        const serviceName = endpoint.Properties?.ServiceName;
        if (typeof serviceName === 'string') {
          // Service name like "com.amazonaws.ap-northeast-1.ssm"
          return serviceName.endsWith('.ssm');
        }
        if (serviceName?.["Fn::Join"]) {
          const parts = serviceName["Fn::Join"][1];
          // Check if the service name ends with ".ssm"
          const serviceStr = parts.join('');
          return serviceStr.endsWith('.ssm');
        }
        return false;
      });
      expect(ssmEndpoint).toBeDefined();
    });

    test("should create SSM Messages Interface Endpoint", () => {
      const endpoints = stackTemplate.findResources("AWS::EC2::VPCEndpoint");
      const ssmMessagesEndpoint = Object.values(endpoints).find((endpoint: any) => {
        const serviceName = endpoint.Properties?.ServiceName;
        if (typeof serviceName === 'string') {
          return serviceName.includes('ssmmessages');
        }
        if (serviceName?.["Fn::Join"]) {
          const parts = serviceName["Fn::Join"][1];
          return parts.some((part: any) => typeof part === 'string' && part.includes('ssmmessages'));
        }
        return false;
      });
      expect(ssmMessagesEndpoint).toBeDefined();
    });

    test("Interface Endpoints should be in private subnets", () => {
      const endpoints = stackTemplate.findResources("AWS::EC2::VPCEndpoint");
      const interfaceEndpoints = Object.values(endpoints).filter((endpoint: any) =>
        endpoint.Properties?.VpcEndpointType === "Interface"
      );
      interfaceEndpoints.forEach((endpoint: any) => {
        expect(endpoint.Properties?.SubnetIds).toBeDefined();
        expect(Array.isArray(endpoint.Properties?.SubnetIds)).toBe(true);
      });
    });

    test("Interface Endpoints should have security groups", () => {
      const endpoints = stackTemplate.findResources("AWS::EC2::VPCEndpoint");
      const interfaceEndpoints = Object.values(endpoints).filter((endpoint: any) =>
        endpoint.Properties?.VpcEndpointType === "Interface"
      );
      interfaceEndpoints.forEach((endpoint: any) => {
        expect(endpoint.Properties?.SecurityGroupIds).toBeDefined();
        expect(Array.isArray(endpoint.Properties?.SecurityGroupIds)).toBe(true);
      });
    });
  });

  describe("Security Groups", () => {
    test("should create security groups", () => {
      const sgCount = stackTemplate.findResources("AWS::EC2::SecurityGroup");
      expect(Object.keys(sgCount).length).toBeGreaterThanOrEqual(2);
    });

    test("should create EC2 Instance Connect security group", () => {
      stackTemplate.hasResourceProperties("AWS::EC2::SecurityGroup", {
        GroupDescription: "Security group for EC2 Instance Connect Endpoint",
      });
    });

    test("should create EC2 instance security group", () => {
      stackTemplate.hasResourceProperties("AWS::EC2::SecurityGroup", {
        GroupDescription: "Security group for EC2 instances",
      });
    });

    test("EC2 security group should allow SSH from Instance Connect SG", () => {
      stackTemplate.hasResourceProperties("AWS::EC2::SecurityGroupIngress", {
        IpProtocol: "tcp",
        FromPort: 22,
        ToPort: 22,
        Description: "Allow SSH from Instance Connect SG",
      });
    });

    test("Instance Connect SG should allow SSH egress to EC2 SG", () => {
      stackTemplate.hasResourceProperties("AWS::EC2::SecurityGroupEgress", {
        IpProtocol: "tcp",
        FromPort: 22,
        ToPort: 22,
        Description: "Allow SSH to EC2 SG",
      });
    });
  });

  describe("EC2 Instance Connect Endpoint", () => {
    test("should create Instance Connect Endpoint", () => {
      stackTemplate.resourceCountIs("AWS::EC2::InstanceConnectEndpoint", 1);
    });

    test("Instance Connect Endpoint should have preserveClientIp disabled", () => {
      stackTemplate.hasResourceProperties("AWS::EC2::InstanceConnectEndpoint", {
        PreserveClientIp: false,
      });
    });

    test("Instance Connect Endpoint should have security group", () => {
      const endpoints = stackTemplate.findResources("AWS::EC2::InstanceConnectEndpoint");
      const endpoint = Object.values(endpoints)[0] as any;
      expect(endpoint.Properties?.SecurityGroupIds).toBeDefined();
      expect(Array.isArray(endpoint.Properties?.SecurityGroupIds)).toBe(true);
      expect(endpoint.Properties?.SecurityGroupIds.length).toBeGreaterThanOrEqual(1);
    });

    test("Instance Connect Endpoint should be in InternalSubnet", () => {
      const endpoints = stackTemplate.findResources("AWS::EC2::InstanceConnectEndpoint");
      const endpoint = Object.values(endpoints)[0] as any;
      expect(endpoint.Properties?.SubnetId).toBeDefined();
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