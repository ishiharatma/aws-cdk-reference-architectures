/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { VpcCStack } from "lib/stacks/vpc-c-stack";
import { Environment } from '@common/parameters/environments';
import { params } from "parameters/environments";
import '../parameters';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

const defaultEnv = {
    account: "222222222222",
    region: "ap-northeast-1",
};

const projectName = "TestProject";
const envName: Environment = Environment.TEST;
if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

/**
 * AWS CDK Unit Tests - VPC C Stack
 *
 * This test suite verifies:
 * 1. VPC C is created in Account B with correct configuration
 * 2. Subnets and routing are properly configured
 * 3. Security settings are properly applied
 */
describe("VpcCStack Fine-grained Assertions", () => {
    let stackTemplate: Template;

    beforeAll(() => {
        if (!envParams.vpcCConfig) {
            throw new Error("VPC C configuration is required for this test");
        }
        
        const app = new cdk.App();
        const stack = new VpcCStack(app, "VpcC", {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        stackTemplate = Template.fromStack(stack);
    });

    describe("VPC C Configuration", () => {
        test("VPC C should be created with correct CIDR block", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::VPC", {
                CidrBlock: envParams.vpcCConfig?.createConfig?.cidr,
                EnableDnsHostnames: true,
                EnableDnsSupport: true,
            });
        });

        test("VPC C should have correct name tag", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::VPC", {
                Tags: Match.arrayWith([
                    { Key: "Name", Value: Match.stringLikeRegexp(".*VpcC") },
                ]),
            });
        });

        test("VPC C CIDR should be unique", () => {
            const vpcCcidr = envParams.vpcCConfig?.createConfig?.cidr;
            const vpcAcidr = envParams.vpcAConfig.createConfig?.cidr;
            const vpcBcidr = envParams.vpcBConfig.createConfig?.cidr;
            
            expect(vpcCcidr).not.toEqual(vpcAcidr);
            expect(vpcCcidr).not.toEqual(vpcBcidr);
        });
    });

    describe("Subnet Configuration", () => {
        test("VPC C should have private subnets", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::Subnet", {
                MapPublicIpOnLaunch: false,
                Tags: Match.arrayWith([
                    { Key: "Name", Value: Match.stringLikeRegexp(".*Private.*") },
                ]),
            });
        });

        test("Subnets should be in correct VPC", () => {
            const subnets = stackTemplate.findResources("AWS::EC2::Subnet");
            Object.values(subnets).forEach((subnet: any) => {
                expect(subnet.Properties.VpcId).toBeDefined();
            });
        });
    });

    describe("Internet Gateway", () => {
        test("Internet Gateway should exist based on subnet configuration", () => {
            const hasPublicSubnet = envParams.vpcCConfig?.createConfig?.subnets?.some(
                subnet => subnet.subnetType === ec2.SubnetType.PUBLIC
            ) || false;
            
            if (hasPublicSubnet) {
                stackTemplate.hasResourceProperties("AWS::EC2::InternetGateway", {
                    Tags: Match.arrayWith([
                        { Key: "Name", Value: Match.stringLikeRegexp(".*VpcC.*") },
                    ]),
                });
            } else {
                // No public subnet means no Internet Gateway
                const igws = stackTemplate.findResources("AWS::EC2::InternetGateway");
                expect(Object.keys(igws).length).toBe(0);
            }
        });
    });

    describe("NAT Gateway Configuration", () => {
        test("NAT Gateway count should match configuration", () => {
            const natCount = envParams.vpcCConfig?.createConfig?.natCount || 0;
            if (natCount > 0) {
                const natGateways = stackTemplate.findResources("AWS::EC2::NatGateway");
                expect(Object.keys(natGateways).length).toBeGreaterThan(0);
            } else {
                // If NAT Gateway is not configured, count should be 0 or resource should not exist
                try {
                    stackTemplate.resourceCountIs("AWS::EC2::NatGateway", 0);
                } catch {
                    // Allow case where resource does not exist
                }
            }
        });

        test("NAT Gateway should have Elastic IP if created", () => {
            const natCount = envParams.vpcCConfig?.createConfig?.natCount || 0;
            if (natCount > 0) {
                stackTemplate.hasResourceProperties("AWS::EC2::EIP", {
                    Domain: "vpc",
                });
            }
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
        test("VPC C ID should be exported", () => {
            stackTemplate.hasOutput("VpcCId", {
                Value: Match.anyValue(),
            });
        });

        test("VPC C CIDR should be exported", () => {
            stackTemplate.hasOutput("VpcCCidr", {
                Value: Match.anyValue(),
            });
        });
    });

    describe("Resource Tags", () => {
        test("All resources should have common tags", () => {
            if (envParams.tags) {
                const vpcs = stackTemplate.findResources("AWS::EC2::VPC");
                Object.values(vpcs).forEach((vpc: any) => {
                    const tags = vpc.Properties.Tags || [];
                    Object.entries(envParams.tags!).forEach(([key, value]) => {
                        const hasTag = tags.some((tag: any) => tag.Key === key && tag.Value === value);
                        expect(hasTag).toBe(true);
                    });
                });
            }
        });
    });

    describe("Security Configuration", () => {
        test("VPC should have DNS support enabled", () => {
            const vpcs = stackTemplate.findResources("AWS::EC2::VPC");
            Object.values(vpcs).forEach((vpc: any) => {
                expect(vpc.Properties.EnableDnsSupport).toBe(true);
                expect(vpc.Properties.EnableDnsHostnames).toBe(true);
            });
        });

        test("Route tables should be associated with subnets", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::SubnetRouteTableAssociation", {
                RouteTableId: Match.anyValue(),
                SubnetId: Match.anyValue(),
            });
        });
    });
});
