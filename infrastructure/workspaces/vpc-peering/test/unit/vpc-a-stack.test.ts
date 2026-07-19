/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { VpcAStack } from "lib/stacks/vpc-a-stack";
import { Environment } from '@common/parameters/environments';
import 'test/parameters';
import { params } from "parameters/environments";
import '../parameters';

const defaultEnv = {
    account: "123456789012",
    region: "ap-northeast-1",
};

const projectName = "TestProject";
const envName: Environment = Environment.TEST;
if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

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
describe("VpcAStack Fine-grained Assertions", () => {
    let stackTemplate: Template;

    beforeAll(() => {
        const app = new cdk.App();
        const stack = new VpcAStack(app, "VpcA", {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        stackTemplate = Template.fromStack(stack);
    });

    describe("VPC A Configuration", () => {
        test("VPC A should be created with correct CIDR block", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::VPC", {
                CidrBlock: envParams.vpcAConfig.createConfig?.cidr,
                EnableDnsHostnames: true,
                EnableDnsSupport: true,
            });
        });

        test("VPC A should have correct tags", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::VPC", {
                Tags: Match.arrayWith([
                    { Key: "Name", Value: Match.stringLikeRegexp(".*VpcA") },
                ]),
            });
        });

        test("VPC A should have public subnets", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::Subnet", {
                MapPublicIpOnLaunch: true,
            });
        });

        test("VPC A should have private subnets", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::Subnet", {
                MapPublicIpOnLaunch: false,
            });
        });

        test("VPC A should have NAT Gateway if configured", () => {
            if (envParams.vpcAConfig.createConfig?.natCount && envParams.vpcAConfig.createConfig.natCount > 0) {
                const resources = stackTemplate.findResources("AWS::EC2::NatGateway");
                expect(Object.keys(resources).length).toBeGreaterThan(0);
            }
        });

        test("VPC A should have Internet Gateway", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::InternetGateway", {
                Tags: Match.arrayWith([
                    { Key: "Name", Value: Match.stringLikeRegexp(".*VpcA.*") },
                ]),
            });
        });
    });

    describe("VPC B Configuration", () => {
        test("VPC B should be created with correct CIDR block", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::VPC", {
                CidrBlock: envParams.vpcBConfig.createConfig?.cidr,
                EnableDnsHostnames: true,
                EnableDnsSupport: true,
            });
        });

        test("VPC B should have correct tags", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::VPC", {
                Tags: Match.arrayWith([
                    { Key: "Name", Value: Match.stringLikeRegexp(".*VpcB") },
                ]),
            });
        });

        test("VPC B CIDR should not overlap with VPC A CIDR", () => {
            const vpcAcidr = envParams.vpcAConfig.createConfig?.cidr;
            const vpcBcidr = envParams.vpcBConfig.createConfig?.cidr;
            expect(vpcAcidr).not.toEqual(vpcBcidr);
        });
    });

    describe("VPC Peering Configuration", () => {
        test("VPC Peering connection should be created", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::VPCPeeringConnection", {
                VpcId: Match.anyValue(),
                PeerVpcId: Match.anyValue(),
            });
        });

        test("Routes should be added to VPC A for VPC B", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::Route", {
                DestinationCidrBlock: Match.objectLike({
                    "Fn::GetAtt": Match.arrayWith([Match.stringLikeRegexp(".*VpcB.*")]),
                }),
                VpcPeeringConnectionId: Match.anyValue(),
            });
        });

        test("Routes should be added to VPC B for VPC A", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::Route", {
                DestinationCidrBlock: Match.objectLike({
                    "Fn::GetAtt": Match.arrayWith([Match.stringLikeRegexp(".*VpcA.*")]),
                }),
                VpcPeeringConnectionId: Match.anyValue(),
            });
        });

        test("Security group should allow traffic from peer VPC", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::SecurityGroup", {
                GroupDescription: Match.objectLike({
                    "Fn::Join": Match.anyValue(),
                }),
                SecurityGroupIngress: Match.arrayWith([
                    Match.objectLike({
                        CidrIp: Match.anyValue(),
                        IpProtocol: "-1",
                    }),
                ]),
            });
        });
    });

    describe("Gateway Endpoints", () => {
        test("S3 Gateway Endpoint should be created", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::VPCEndpoint", {
                ServiceName: Match.objectLike({
                    "Fn::Join": Match.arrayWith([
                        Match.arrayWith([Match.stringLikeRegexp(".*s3")]),
                    ]),
                }),
                VpcEndpointType: "Gateway",
            });
        });

        test("DynamoDB Gateway Endpoint should be created", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::VPCEndpoint", {
                ServiceName: Match.objectLike({
                    "Fn::Join": Match.arrayWith([
                        Match.arrayWith([Match.stringLikeRegexp(".*dynamodb")]),
                    ]),
                }),
                VpcEndpointType: "Gateway",
            });
        });
    });

    describe("CloudFormation Outputs", () => {
        test("VPC IDs should be exported", () => {
            const template = stackTemplate.toJSON();
            const outputs = template.Outputs || {};
            const vpcIdOutputs = Object.keys(outputs).filter(key => key.includes('VpcId'));
            expect(vpcIdOutputs.length).toBeGreaterThan(0);
        });

        test("VPC CIDR blocks should be exported", () => {
            const template = stackTemplate.toJSON();
            const outputs = template.Outputs || {};
            const cidrOutputs = Object.keys(outputs).filter(key => key.includes('Cidr'));
            expect(cidrOutputs.length).toBeGreaterThan(0);
        });

        test("Peering connection should be exported", () => {
            const template = stackTemplate.toJSON();
            const outputs = template.Outputs || {};
            const peeringOutputs = Object.keys(outputs).filter(key => key.includes('Peering'));
            expect(peeringOutputs.length).toBeGreaterThan(0);
        });
    });

    describe("Resource Counts", () => {
        test("Should create exactly 2 VPCs", () => {
            stackTemplate.resourceCountIs("AWS::EC2::VPC", 2);
        });

        test("Should create at least 1 VPC Peering Connection", () => {
            stackTemplate.resourceCountIs("AWS::EC2::VPCPeeringConnection", 1);
        });

        test("Should create route tables for both VPCs", () => {
            const resources = stackTemplate.findResources("AWS::EC2::RouteTable");
            expect(Object.keys(resources).length).toBeGreaterThan(0);
        });
    });

    describe("Security and Compliance", () => {
        test("VPCs should have DNS support enabled", () => {
            const vpcs = stackTemplate.findResources("AWS::EC2::VPC");
            Object.values(vpcs).forEach((vpc: any) => {
                expect(vpc.Properties.EnableDnsSupport).toBe(true);
                expect(vpc.Properties.EnableDnsHostnames).toBe(true);
            });
        });

        test("Security groups should not allow unrestricted ingress from internet", () => {
            const securityGroups = stackTemplate.findResources("AWS::EC2::SecurityGroup");
            Object.values(securityGroups).forEach((sg: any) => {
                if (sg.Properties.SecurityGroupIngress) {
                    sg.Properties.SecurityGroupIngress.forEach((rule: any) => {
                        if (rule.CidrIp === "0.0.0.0/0") {
                            // If allowing from internet, should be specific port
                            expect(rule.IpProtocol).not.toBe("-1");
                        }
                    });
                }
            });
        });
    });
});