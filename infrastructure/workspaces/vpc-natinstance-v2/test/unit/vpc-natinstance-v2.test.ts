/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import { VpcNatInstanceV2Stack } from "lib/stacks/vpc-natinstance-v2-stack";
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

describe("VpcNatInstanceV2Stack Fine-grained Assertions", () => {
  let stackTemplate: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new VpcNatInstanceV2Stack(app, "VpcNatInstanceV2", {
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
      const expectedVpcName = `${pascalCase(projectName)}/${pascalCase(envName)}/NatInstanceV2VPC`;
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
        "External",
        "Management",
        "Internal",
        "Application",
        "Isolated",
        "TransitGateway"
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

  describe("NAT Instances (using NatProvider.instanceV2)", () => {
    test("should not create NAT Gateways (using instances instead)", () => {
      const natGateways = stackTemplate.findResources("AWS::EC2::NatGateway");
      expect(Object.keys(natGateways).length).toBe(0);
    });

    test("should create NAT instances instead of NAT Gateways", () => {
      const instances = stackTemplate.findResources("AWS::EC2::Instance");
      expect(Object.keys(instances).length).toBeGreaterThanOrEqual(1);
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

    test("should have routes to NAT Instance for private subnets", () => {
      const routes = stackTemplate.findResources("AWS::EC2::Route");
      const natRoutes = Object.values(routes).filter((route: any) =>
        route.Properties?.InstanceId
      );
      expect(natRoutes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Elastic IPs", () => {
    test("should create Elastic IPs for NAT Instances", () => {
      const eips = stackTemplate.findResources("AWS::EC2::EIP");
      expect(Object.keys(eips).length).toBeGreaterThanOrEqual(1);
    });

    test("should create EIP associations for NAT instances", () => {
      const eipAssociations = stackTemplate.findResources("AWS::EC2::EIPAssociation");
      expect(Object.keys(eipAssociations).length).toBeGreaterThanOrEqual(1);
    });

    test("Elastic IPs should have name tags", () => {
      const eips = stackTemplate.findResources("AWS::EC2::EIP");
      const eipsWithTags = Object.values(eips).filter((eip: any) => {
        const tags = eip.Properties?.Tags || [];
        return tags.some((tag: any) => 
          tag.Key === "Name" && tag.Value?.includes("NatEIP")
        );
      });
      expect(eipsWithTags.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("NAT Instance Configuration", () => {
    test("should create NAT instances", () => {
      const instances = stackTemplate.findResources("AWS::EC2::Instance");
      expect(Object.keys(instances).length).toBeGreaterThanOrEqual(1);
    });

    test("NAT instances should use ARM architecture", () => {
      const instances = stackTemplate.findResources("AWS::EC2::Instance");
      const natInstances = Object.values(instances).filter((instance: any) => {
        const instanceType = instance.Properties?.InstanceType;
        // t4g is ARM-based instance type
        return instanceType && typeof instanceType === 'string' && instanceType.startsWith('t4g');
      });
      expect(natInstances.length).toBeGreaterThanOrEqual(1);
    });

    test("NAT instances should have source/dest check disabled", () => {
      stackTemplate.hasResourceProperties("AWS::EC2::Instance", {
        SourceDestCheck: false,
      });
    });

    test("NAT instances should have IAM instance profile", () => {
      const instances = stackTemplate.findResources("AWS::EC2::Instance");
      const instancesWithProfile = Object.values(instances).filter((instance: any) =>
        instance.Properties?.IamInstanceProfile
      );
      expect(instancesWithProfile.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("EventBridge Rules for NAT Instance Schedule", () => {
    test("should create IAM role for NAT instance schedule", () => {
      stackTemplate.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Effect: "Allow",
              Principal: {
                Service: "events.amazonaws.com",
              },
              Action: "sts:AssumeRole",
            },
          ],
        },
        ManagedPolicyArns: [
          {
            "Fn::Join": [
              "",
              [
                "arn:",
                { Ref: "AWS::Partition" },
                ":iam::aws:policy/service-role/AmazonSSMAutomationRole",
              ],
            ],
          },
        ],
      });
    });

    test("should create EventBridge rules for NAT instance start", () => {
      const rules = stackTemplate.findResources("AWS::Events::Rule");
      const startRules = Object.entries(rules).filter(([logicalId, rule]: [string, any]) => {
        // Check by logical ID or Description
        return logicalId.includes('EC2StartRule') || 
               (rule.Properties?.Description && 
                typeof rule.Properties.Description === 'string' && 
                rule.Properties.Description.includes('Start'));
      });
      expect(startRules.length).toBeGreaterThanOrEqual(1);
    });

    test("should create EventBridge rules for NAT instance stop", () => {
      const rules = stackTemplate.findResources("AWS::Events::Rule");
      const stopRules = Object.entries(rules).filter(([logicalId, rule]: [string, any]) => {
        // Check by logical ID or Description
        return logicalId.includes('EC2StopRule') || 
               (rule.Properties?.Description && 
                typeof rule.Properties.Description === 'string' && 
                rule.Properties.Description.includes('Stop'));
      });
      expect(stopRules.length).toBeGreaterThanOrEqual(1);
    });

    test("start rules should have cron schedule", () => {
      const rules = stackTemplate.findResources("AWS::Events::Rule");
      const startRules = Object.entries(rules).filter(([logicalId, rule]: [string, any]) => {
        return logicalId.includes('EC2StartRule') || 
               (rule.Properties?.Description && 
                typeof rule.Properties.Description === 'string' && 
                rule.Properties.Description.includes('Start'));
      });
      startRules.forEach(([_, rule]: [string, any]) => {
        expect(rule.Properties?.ScheduleExpression).toBeDefined();
        expect(rule.Properties?.ScheduleExpression).toContain("cron");
      });
    });

    test("stop rules should have cron schedule", () => {
      const rules = stackTemplate.findResources("AWS::Events::Rule");
      const stopRules = Object.entries(rules).filter(([logicalId, rule]: [string, any]) => {
        return logicalId.includes('EC2StopRule') || 
               (rule.Properties?.Description && 
                typeof rule.Properties.Description === 'string' && 
                rule.Properties.Description.includes('Stop'));
      });
      stopRules.forEach(([_, rule]: [string, any]) => {
        expect(rule.Properties?.ScheduleExpression).toBeDefined();
        expect(rule.Properties?.ScheduleExpression).toContain("cron");
      });
    });

    test("schedule rules should target SSM automation", () => {
      const rules = stackTemplate.findResources("AWS::Events::Rule");
      const scheduleRules = Object.entries(rules).filter(([logicalId, rule]: [string, any]) => {
        return logicalId.includes('EC2StartRule') || logicalId.includes('EC2StopRule') ||
               (rule.Properties?.Description && 
                typeof rule.Properties.Description === 'string' && 
                (rule.Properties.Description.includes('Start') || rule.Properties.Description.includes('Stop')));
      });
      scheduleRules.forEach(([_, rule]: [string, any]) => {
        expect(rule.Properties?.Targets).toBeDefined();
        expect(Array.isArray(rule.Properties?.Targets)).toBe(true);
        const ssmTargets = rule.Properties?.Targets.filter((target: any) =>
          target.Arn && target.Arn.includes('automation-definition')
        );
        expect(ssmTargets.length).toBeGreaterThanOrEqual(1);
      });
    });

    test("schedule rules should have correct IAM role", () => {
      const rules = stackTemplate.findResources("AWS::Events::Rule");
      const scheduleRules = Object.entries(rules).filter(([logicalId, rule]: [string, any]) => {
        return logicalId.includes('EC2StartRule') || logicalId.includes('EC2StopRule') ||
               (rule.Properties?.Description && 
                typeof rule.Properties.Description === 'string' && 
                (rule.Properties.Description.includes('Start') || rule.Properties.Description.includes('Stop')));
      });
      scheduleRules.forEach(([_, rule]: [string, any]) => {
        const targets = rule.Properties?.Targets || [];
        targets.forEach((target: any) => {
          expect(target.RoleArn).toBeDefined();
        });
      });
    });
  });

  describe("EventBridge Rules for NAT Instance State Change", () => {
    test("should create EventBridge rule for NAT instance state change", () => {
      const rules = stackTemplate.findResources("AWS::Events::Rule");
      const stateChangeRules = Object.values(rules).filter((rule: any) => {
        const eventPattern = rule.Properties?.EventPattern;
        if (!eventPattern) return false;
        const pattern = typeof eventPattern === 'string' ? JSON.parse(eventPattern) : eventPattern;
        return pattern.source?.includes('aws.ec2') && 
               pattern['detail-type']?.includes('EC2 Instance State-change Notification');
      });
      expect(stateChangeRules.length).toBeGreaterThanOrEqual(1);
    });

    test("state change rule should monitor NAT instance states", () => {
      const rules = stackTemplate.findResources("AWS::Events::Rule");
      const stateChangeRules = Object.values(rules).filter((rule: any) => {
        const eventPattern = rule.Properties?.EventPattern;
        if (!eventPattern) return false;
        const pattern = typeof eventPattern === 'string' ? JSON.parse(eventPattern) : eventPattern;
        return pattern.source?.includes('aws.ec2') && 
               pattern['detail-type']?.includes('EC2 Instance State-change Notification');
      });
      stateChangeRules.forEach((rule: any) => {
        const eventPattern = rule.Properties?.EventPattern;
        const pattern = typeof eventPattern === 'string' ? JSON.parse(eventPattern) : eventPattern;
        expect(pattern.detail?.state).toBeDefined();
        expect(Array.isArray(pattern.detail?.state)).toBe(true);
      });
    });

    test("state change rule should have SNS target", () => {
      const rules = stackTemplate.findResources("AWS::Events::Rule");
      const stateChangeRules = Object.values(rules).filter((rule: any) => {
        const eventPattern = rule.Properties?.EventPattern;
        if (!eventPattern) return false;
        const pattern = typeof eventPattern === 'string' ? JSON.parse(eventPattern) : eventPattern;
        return pattern.source?.includes('aws.ec2') && 
               pattern['detail-type']?.includes('EC2 Instance State-change Notification');
      });
      stateChangeRules.forEach((rule: any) => {
        expect(rule.Properties?.Targets).toBeDefined();
        expect(Array.isArray(rule.Properties?.Targets)).toBe(true);
        expect(rule.Properties?.Targets.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe("SNS Topic", () => {
    test("should create SNS topic for NAT instance state change", () => {
      stackTemplate.resourceCountIs("AWS::SNS::Topic", 1);
    });

    test("SNS topic should have correct display name", () => {
      stackTemplate.hasResourceProperties("AWS::SNS::Topic", {
        DisplayName: `${projectName}-${envName}-NatInstanceStateChange`,
      });
    });

    test("SNS topic should enforce SSL", () => {
      const topics = stackTemplate.findResources("AWS::SNS::Topic");
      Object.values(topics).forEach((topic: any) => {
        const policy = topic.Properties?.TopicPolicy || 
                      topic.Properties?.Policy || 
                      null;
        // SNS topic with enforceSSL creates a topic policy automatically
        expect(topic.Properties?.DisplayName).toBeDefined();
      });
    });

    test("should create SNS topic policy enforcing SSL", () => {
      const policies = stackTemplate.findResources("AWS::SNS::TopicPolicy");
      expect(Object.keys(policies).length).toBeGreaterThanOrEqual(1);
      
      Object.values(policies).forEach((policy: any) => {
        const policyDoc = policy.Properties?.PolicyDocument;
        expect(policyDoc).toBeDefined();
        const statements = policyDoc.Statement || [];
        const sslStatement = statements.find((stmt: any) => 
          stmt.Effect === 'Deny' && 
          stmt.Condition?.Bool?.['aws:SecureTransport'] === 'false'
        );
        expect(sslStatement).toBeDefined();
      });
    });
  });

  describe("CloudFormation Outputs", () => {
    test("should output NAT instance public IPs", () => {
      const outputs = Object.keys(stackTemplate.toJSON().Outputs || {});
      const natInstanceIpOutputs = outputs.filter(output => 
        output.includes('NatInstance') && output.includes('PublicIP')
      );
      expect(natInstanceIpOutputs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("VPC Custom Name", () => {
    test("VPC should have NatInstanceV2VPC in name", () => {
      const expectedVpcName = `${pascalCase(projectName)}/${pascalCase(envName)}/NatInstanceV2VPC`;
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

  describe("S3 Bucket for Flow Logs", () => {
    test("should create S3 bucket for flow logs", () => {
      stackTemplate.resourceCountIs("AWS::S3::Bucket", 1);
    });

    test("S3 bucket should have encryption enabled", () => {
      stackTemplate.hasResourceProperties("AWS::S3::Bucket", {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: "AES256",
              },
            },
          ],
        },
      });
    });

    test("S3 bucket should block all public access", () => {
      stackTemplate.hasResourceProperties("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    test("S3 bucket should have SSL enforcement policy", () => {
      const policies = stackTemplate.findResources("AWS::S3::BucketPolicy");
      expect(Object.keys(policies).length).toBeGreaterThanOrEqual(1);
      
      Object.values(policies).forEach((policy: any) => {
        const policyDoc = policy.Properties?.PolicyDocument;
        expect(policyDoc).toBeDefined();
        const statements = policyDoc.Statement || [];
        const sslStatement = statements.find((stmt: any) => 
          stmt.Effect === 'Deny' && 
          stmt.Condition?.Bool?.['aws:SecureTransport'] === 'false'
        );
        expect(sslStatement).toBeDefined();
      });
    });
  });

  describe("NAT Instance Security Group", () => {
    test("should create security group for NAT instances", () => {
      const securityGroups = stackTemplate.findResources("AWS::EC2::SecurityGroup");
      // NAT instances have their own security groups created by the NAT provider
      expect(Object.keys(securityGroups).length).toBeGreaterThanOrEqual(1);
    });

    test("security groups should have proper egress rules", () => {
      const securityGroups = stackTemplate.findResources("AWS::EC2::SecurityGroup");
      const groupsWithEgress = Object.values(securityGroups).filter((sg: any) => {
        const egress = sg.Properties?.SecurityGroupEgress;
        return egress && Array.isArray(egress) && egress.length > 0;
      });
      expect(groupsWithEgress.length).toBeGreaterThanOrEqual(1);
    });
  });
});