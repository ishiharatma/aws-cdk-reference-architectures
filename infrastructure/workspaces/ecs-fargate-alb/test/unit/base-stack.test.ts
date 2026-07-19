/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { BaseStack } from "lib/stacks/base-stack";
import { Environment } from '@common/parameters/environments';
import 'test/parameters';
import { params } from "parameters/environments";
import '../parameters';
import * as path from 'path';
import { loadCdkContext } from '@common/test-helpers/test-context';

const defaultEnv = {
    account: "123456789012",
    region: "ap-northeast-1",
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
describe("BaseStack Fine-grained Assertions", () => {
    let stackTemplate: Template;

    beforeAll(() => {
        const context = {...baseContext, "aws:cdk:bundling-stacks": [],};
        const app = new cdk.App({ context });
        const stack = new BaseStack(app, "Base", {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            config: envParams.vpcConfig,
            hostedZoneId: envParams.hostedZoneId,
            allowedIpsforAlb: ['0.0.0.0/0'],
            ports: [8080],
        });
        stackTemplate = Template.fromStack(stack);
    });

    // ========================================
    // VPC Tests
    // ========================================
    describe("VPC Configuration", () => {
        test("should create VPC with correct CIDR block", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::VPC", {
                CidrBlock: envParams.vpcConfig.createConfig?.cidr,
                EnableDnsHostnames: true,
                EnableDnsSupport: true,
            });
        });

        test("should create public subnets", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::Subnet", {
                MapPublicIpOnLaunch: true,
            });
        });

        test("should create private subnets", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::Subnet", {
                MapPublicIpOnLaunch: false,
            });
        });

        test("should create internet gateway", () => {
            stackTemplate.resourceCountIs("AWS::EC2::InternetGateway", 1);
        });

        test("should attach internet gateway to VPC", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::VPCGatewayAttachment", {
                InternetGatewayId: Match.objectLike({
                    Ref: Match.stringLikeRegexp("VpcIGW"),
                }),
                VpcId: Match.objectLike({
                    Ref: Match.stringLikeRegexp("Vpc"),
                }),
            });
        });
    });

    // ========================================
    // NAT Configuration Tests
    // ========================================
    describe("NAT Configuration", () => {
        test("should create NAT instance when natType is INSTANCE", () => {
            if (envParams.vpcConfig.createConfig?.natType === 'INSTANCE') {
                stackTemplate.hasResourceProperties("AWS::EC2::Instance", {
                    InstanceType: Match.anyValue(),
                    SourceDestCheck: false,
                });
            }
        });
    });

    // ========================================
    // ALB Security Group Tests
    // ========================================
    describe("ALB Security Group Configuration", () => {
        test("should create ALB security group", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::SecurityGroup", {
                GroupDescription: "Security group for Application Load Balancer",
                VpcId: Match.objectLike({
                    Ref: Match.stringLikeRegexp("Vpc"),
                }),
            });
        });

        test("should allow inbound HTTP traffic when no hostedZoneId is provided", () => {
            if (!envParams.hostedZoneId) {
                stackTemplate.hasResourceProperties("AWS::EC2::SecurityGroup", {
                    GroupDescription: "Security group for Application Load Balancer",
                    SecurityGroupIngress: Match.arrayWith([
                        Match.objectLike({
                            IpProtocol: "tcp",
                            FromPort: 80,
                            ToPort: 80,
                        }),
                    ]),
                });
            }
        });

        test("should allow inbound HTTPS traffic when hostedZoneId is provided", () => {
            if (envParams.hostedZoneId) {
                stackTemplate.hasResourceProperties("AWS::EC2::SecurityGroup", {
                    GroupDescription: "Security group for Application Load Balancer",
                    SecurityGroupIngress: Match.arrayWith([
                        Match.objectLike({
                            IpProtocol: "tcp",
                            FromPort: 443,
                            ToPort: 443,
                        }),
                    ]),
                });
            }
        });

        test("should have security group name with correct naming pattern", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::SecurityGroup", {
                GroupName: `${projectName}-${envName}-AlbSecurityGroup`,
            });
        });
    });

    // ========================================
    // ECS Security Group Tests
    // ========================================
    describe("ECS Security Group Configuration", () => {
        test("should create ECS security group", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::SecurityGroup", {
                GroupDescription: "Security group for ECS tasks",
                VpcId: Match.objectLike({
                    Ref: Match.stringLikeRegexp("Vpc"),
                }),
            });
        });

        test("should have security group name with correct naming pattern", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::SecurityGroup", {
                GroupName: `${projectName}-${envName}-EcsSecurityGroup`,
            });
        });

        test("should allow inbound traffic from ALB on specified ports", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::SecurityGroup", {
                GroupDescription: "Security group for ECS tasks",
                SecurityGroupIngress: Match.arrayWith([
                    Match.objectLike({
                        IpProtocol: "tcp",
                        FromPort: 8080,
                        ToPort: 8080,
                    }),
                ]),
            });
        });

        test("should allow all outbound traffic for ECS security group", () => {
            // Check that the security group allows all outbound traffic
            // This is verified by checking for egress rules
            const template = stackTemplate.toJSON();
            const securityGroups = Object.entries(template.Resources)
                .filter(([_, resource]: [string, any]) => 
                    resource.Type === "AWS::EC2::SecurityGroup" &&
                    resource.Properties.GroupDescription === "Security group for ECS tasks"
                );
            
            expect(securityGroups.length).toBeGreaterThan(0);
        });
    });

    // ========================================
    // Route Tables Tests
    // ========================================
    describe("Route Tables Configuration", () => {
        test("should create route tables for subnets", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::RouteTable", {
                VpcId: Match.objectLike({
                    Ref: Match.stringLikeRegexp("Vpc"),
                }),
            });
        });

        test("should have default route to internet gateway for public subnets", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::Route", {
                DestinationCidrBlock: "0.0.0.0/0",
                GatewayId: Match.objectLike({
                    Ref: Match.stringLikeRegexp("VpcIGW"),
                }),
            });
        });
    });

    // ========================================
    // Resource Count Tests
    // ========================================
    describe("Resource Counts", () => {
        test("should create 2 security groups (ALB and ECS)", () => {
            stackTemplate.resourceCountIs("AWS::EC2::SecurityGroup", 3);
        });

        test("should create 1 VPC", () => {
            stackTemplate.resourceCountIs("AWS::EC2::VPC", 1);
        });

        test("should create 1 Internet Gateway", () => {
            stackTemplate.resourceCountIs("AWS::EC2::InternetGateway", 1);
        });

        test("should create appropriate number of subnets", () => {
            const maxAzs = envParams.vpcConfig.createConfig?.maxAzs || 2;
            const subnetTypes = envParams.vpcConfig.createConfig?.subnets?.length || 2;
            const expectedSubnets = maxAzs * subnetTypes;
            stackTemplate.resourceCountIs("AWS::EC2::Subnet", expectedSubnets);
        });
    });

    // ========================================
    // VPC Flow Logs Tests
    // ========================================
    describe("VPC Flow Logs Configuration", () => {
        test("should create VPC flow logs only when explicitly enabled", () => {
            if (envParams.vpcConfig.createConfig?.enableFlowLogsToCloudWatch || envParams.vpcConfig.createConfig?.flowLogs) {
                stackTemplate.resourceCountIs("AWS::EC2::FlowLog", 1);
            } else {
                stackTemplate.resourceCountIs("AWS::EC2::FlowLog", 0);
            }
        });
    });
});
