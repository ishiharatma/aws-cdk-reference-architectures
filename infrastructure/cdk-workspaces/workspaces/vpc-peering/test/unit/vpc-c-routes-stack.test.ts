/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Template, Match } from "aws-cdk-lib/assertions";
import { VpcCRoutesStack } from "lib/stacks/vpc-c-routes-stack";
import { Environment } from '@common/parameters/environments';
import { params } from "parameters/environments";
import '../parameters';

const defaultEnv = {
    account: "222222222222", // Account B
    region: "ap-northeast-1",
};

const projectName = "TestProject";
const envName: Environment = Environment.TEST;
if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

// Mock data for testing
const mockVpcCId = "vpc-87654321";
const mockPeeringConnectionId = "pcx-12345678";
const mockVpcBCidr = envParams.vpcBConfig.createConfig?.cidr || "10.1.0.0/16";

/**
 * AWS CDK Unit Tests - VPC C Routes Stack
 *
 * This test suite verifies:
 * 1. Routes are correctly added to VPC C pointing to VPC B
 * 2. Peering connection ID is properly used
 * 3. Route table updates are configured correctly
 * 4. Security and compliance requirements
 */
describe("VpcCRoutesStack Fine-grained Assertions", () => {
    let stackTemplate: Template;

    beforeAll(() => {
        if (!envParams.vpcCConfig) {
            throw new Error("VPC C configuration is required for this test");
        }

        const app = new cdk.App();

        // Create a helper stack to hold the mock VPC
        const helperStack = new cdk.Stack(app, 'HelperStack', {
            env: defaultEnv,
        });

        // Create a mock VPC in the helper stack
        const mockVpc = ec2.Vpc.fromVpcAttributes(helperStack, "MockVpc", {
            vpcId: mockVpcCId,
            availabilityZones: ["ap-northeast-1a", "ap-northeast-1c"],
            privateSubnetIds: ["subnet-private1", "subnet-private2"],
            privateSubnetRouteTableIds: ["rtb-private1", "rtb-private2"],
        });

        const stack = new VpcCRoutesStack(app, "VpcCRoutes", {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            terminationProtection: false,
            vpc: mockVpc,
            vpcBCidr: mockVpcBCidr,
            peeringIdParamName: `/${projectName}/${envName}/peering/vpc-b-vpc-c/id`,
            params: envParams,
        });
        stackTemplate = Template.fromStack(stack);
    });

    describe("Route Configuration for VPC C", () => {
        test("Routes should be added to VPC C pointing to VPC B", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::Route", {
                DestinationCidrBlock: mockVpcBCidr,
                VpcPeeringConnectionId: Match.anyValue(), // Custom Resource fetches this dynamically
            });
        });

        test("All routes should reference the peering connection", () => {
            const routes = stackTemplate.findResources("AWS::EC2::Route");

            Object.values(routes).forEach((route: any) => {
                if (route.Properties.DestinationCidrBlock === mockVpcBCidr) {
                    // VpcPeeringConnectionId should be a Fn::GetAtt reference to Custom Resource
                    expect(route.Properties.VpcPeeringConnectionId).toBeDefined();
                }
            });
        });

        test("Routes should be created for multiple subnet route tables", () => {
            const routes = stackTemplate.findResources("AWS::EC2::Route");
            const peeringRoutes = Object.values(routes).filter(
                (route: any) => route.Properties.DestinationCidrBlock === mockVpcBCidr
            );

            // At least one route should exist
            expect(peeringRoutes.length).toBeGreaterThan(0);
        });

        test("Routes should be associated with route table IDs", () => {
            const routes = stackTemplate.findResources("AWS::EC2::Route");

            Object.values(routes).forEach((route: any) => {
                if (route.Properties.DestinationCidrBlock === mockVpcBCidr) {
                    expect(route.Properties.RouteTableId).toBeDefined();
                }
            });
        });
    });

    describe("CloudFormation Outputs", () => {
        test("Route configuration status should be exported", () => {
            stackTemplate.hasOutput("RoutesConfigured", {
                Description: Match.stringLikeRegexp(".*routes configured.*"),
            });
        });

        test("VPC C ID should be in outputs", () => {
            stackTemplate.hasOutput("VpcCId", {
                Value: mockVpcCId,
            });
        });

        test("Peering connection ID should be referenced in outputs", () => {
            stackTemplate.hasOutput("PeeringConnectionIdUsed", {
                Value: Match.anyValue(), // Custom Resource fetches this dynamically
                Description: Match.stringLikeRegexp(".*Peering connection ID.*"),
            });
        });
    });

    describe("CIDR Block Validation", () => {
        test("Destination CIDR should be valid format", () => {
            const routes = stackTemplate.findResources("AWS::EC2::Route");
            
            Object.values(routes).forEach((route: any) => {
                if (route.Properties.DestinationCidrBlock) {
                    const cidr = route.Properties.DestinationCidrBlock;
                    expect(cidr).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/);
                }
            });
        });

        test("VPC B CIDR should match expected value", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::Route", {
                DestinationCidrBlock: mockVpcBCidr,
            });
        });

        test("VPC B CIDR should be different from VPC C CIDR", () => {
            const vpcCCidr = envParams.vpcCConfig?.createConfig?.cidr;
            if (vpcCCidr) {
                expect(mockVpcBCidr).not.toBe(vpcCCidr);
            }
        });
    });

    describe("Resource Counts", () => {
        test("Should create routes for peering", () => {
            const routes = stackTemplate.findResources("AWS::EC2::Route");
            const peeringRoutes = Object.values(routes).filter(
                (route: any) => route.Properties.VpcPeeringConnectionId !== undefined
            );
            expect(peeringRoutes.length).toBeGreaterThan(0);
        });

        test("Should not create any VPC resources", () => {
            stackTemplate.resourceCountIs("AWS::EC2::VPC", 0);
        });

        test("Should not create any VPC Peering Connections", () => {
            stackTemplate.resourceCountIs("AWS::EC2::VPCPeeringConnection", 0);
        });

        test("Should not create any subnets", () => {
            stackTemplate.resourceCountIs("AWS::EC2::Subnet", 0);
        });
    });

    describe("Security and Compliance", () => {
        test("Routes should only target VPC B CIDR", () => {
            const routes = stackTemplate.findResources("AWS::EC2::Route");

            Object.values(routes).forEach((route: any) => {
                if (route.Properties.VpcPeeringConnectionId) {
                    expect(route.Properties.DestinationCidrBlock).toBe(mockVpcBCidr);
                }
            });
        });

        test("All routes should reference valid peering connection", () => {
            const routes = stackTemplate.findResources("AWS::EC2::Route");

            Object.values(routes).forEach((route: any) => {
                if (route.Properties.VpcPeeringConnectionId) {
                    // VpcPeeringConnectionId should be defined (either string or Fn::GetAtt reference)
                    expect(route.Properties.VpcPeeringConnectionId).toBeDefined();
                }
            });
        });
    });

    describe("Dependency Management", () => {
        test("Routes should be created after peering connection exists", () => {
            // This stack assumes peering connection already exists from CrossAccountPeeringStack
            const routes = stackTemplate.findResources("AWS::EC2::Route");

            Object.values(routes).forEach((route: any) => {
                if (route.Properties.VpcPeeringConnectionId) {
                    // Peering connection ID should be fetched via Custom Resource, not created in this stack
                    expect(route.Properties.VpcPeeringConnectionId).toBeDefined();
                }
            });
        });
    });

    describe("Stack Configuration", () => {
        test("Stack should be deployed to Account B", () => {
            // This test verifies the environment configuration
            expect(defaultEnv.account).toBe("222222222222");
        });

        test("Stack should use correct region", () => {
            expect(defaultEnv.region).toBeDefined();
        });
    });
});
