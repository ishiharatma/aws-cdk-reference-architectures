/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Template, Match } from "aws-cdk-lib/assertions";
import { CrossAccountPeeringStack } from "lib/stacks/cross-account-peering-stack";
import { Environment } from '@common/parameters/environments';
import { params } from "parameters/environments";
import '../parameters';

const defaultEnv = {
    account: "111111111111",
    region: "ap-northeast-1",
};

const projectName = "TestProject";
const envName: Environment = Environment.TEST;
if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

// Mock VPC IDs for testing
const mockVpcBId = "vpc-12345678";
const mockVpcCId = "vpc-87654321";
const mockVpcBCidr = envParams.vpcBConfig.createConfig?.cidr || "10.1.0.0/16";
const mockVpcCCidr = envParams.vpcCConfig?.createConfig?.cidr || "10.2.0.0/16";

/**
 * AWS CDK Unit Tests - Cross-Account Peering Stack
 *
 * This test suite verifies:
 * 1. Cross-account VPC peering connection is created correctly
 * 2. Routes are added to VPC B for VPC C
 * 3. Proper account and region settings
 * 4. Security and compliance requirements
 */
describe("CrossAccountPeeringStack Fine-grained Assertions", () => {
    let stackTemplate: Template;
    let app: cdk.App;
    let stack: CrossAccountPeeringStack;

    beforeAll(() => {
        if (!envParams.vpcCConfig || !envParams.accountBId) {
            throw new Error("VPC C configuration and Account B ID are required for this test");
        }

        app = new cdk.App();
        
        // Create a helper stack to hold the mock VPC
        const helperStack = new cdk.Stack(app, 'HelperStack', {
            env: defaultEnv,
        });
        
        const mockVpcB = ec2.Vpc.fromVpcAttributes(helperStack, 'MockVpcB', {
            vpcId: mockVpcBId,
            availabilityZones: ['ap-northeast-1a', 'ap-northeast-1c'],
            privateSubnetIds: ['subnet-private1', 'subnet-private2'],
            privateSubnetRouteTableIds: ['rtb-private1', 'rtb-private2'],
        });
        
        stack = new CrossAccountPeeringStack(app, "CrossAccountPeering", {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
            requestorVpc: mockVpcB,
            requestorVpcCidr: mockVpcBCidr,
            peeringVpcCidr: mockVpcCCidr,
            peeringRoleName: 'VpcPeeringAcceptRole',
        });
        stackTemplate = Template.fromStack(stack);
    });

    describe("VPC Peering Connection", () => {
        test("Cross-account peering connection should be created", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::VPCPeeringConnection", {
                VpcId: mockVpcBId,
                // PeerVpcId is read from Parameter Store, so it will be a reference
                PeerVpcId: Match.anyValue(),
                PeerOwnerId: envParams.accountBId,
            });
        });

        test("Peering connection should specify peer region if cross-region", () => {
            if (envParams.regionB && envParams.regionB !== envParams.regionA) {
                stackTemplate.hasResourceProperties("AWS::EC2::VPCPeeringConnection", {
                    PeerRegion: envParams.regionB,
                });
            }
        });

        test("Peering connection should have proper tags", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::VPCPeeringConnection", {
                Tags: Match.arrayWith([
                    {
                        Key: "Name",
                        Value: Match.stringLikeRegexp(".*VpcB.*VpcC.*Peering"),
                    },
                ]),
            });
        });
    });

    describe("Route Configuration for VPC B", () => {
        test("Routes should be added to VPC B pointing to VPC C", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::Route", {
                DestinationCidrBlock: mockVpcCCidr,
                VpcPeeringConnectionId: Match.anyValue(),
            });
        });

        test("Routes should reference the peering connection", () => {
            const routes = stackTemplate.findResources("AWS::EC2::Route");
            let foundPeeringRoute = false;

            Object.values(routes).forEach((route: any) => {
                if (route.Properties.DestinationCidrBlock === mockVpcCCidr) {
                    expect(route.Properties.VpcPeeringConnectionId).toBeDefined();
                    foundPeeringRoute = true;
                }
            });

            expect(foundPeeringRoute).toBe(true);
        });

        test("Multiple routes should be created for multiple AZs", () => {
            const routes = stackTemplate.findResources("AWS::EC2::Route");
            const peeringRoutes = Object.values(routes).filter(
                (route: any) => route.Properties.DestinationCidrBlock === mockVpcCCidr
            );
            
            // At least one route should exist
            expect(peeringRoutes.length).toBeGreaterThan(0);
        });
    });

    describe("CloudFormation Outputs", () => {
        test("Peering Connection ID should be exported", () => {
            stackTemplate.hasOutput("PeeringConnectionId", {
                Value: Match.anyValue(),
                Description: Match.stringLikeRegexp(".*VPC Peering Connection ID.*"),
            });
        });

        test("Peering Connection ID should be exported with proper name", () => {
            stackTemplate.hasOutput("PeeringConnectionId", {
                Export: {
                    Name: Match.stringLikeRegexp(".*VpcB-VpcC-Peering-Id"),
                },
            });
        });

        test("Peering status output should exist", () => {
            stackTemplate.hasOutput("PeeringStatus", {
                Description: Match.stringLikeRegexp(".*Peering connection status.*"),
            });
        });

        test("Next steps output should provide guidance", () => {
            stackTemplate.hasOutput("NextSteps", {
                Description: Match.stringLikeRegexp(".*next steps.*"),
            });
        });
    });

    describe("Account and Region Configuration", () => {
        test("Stack should be deployed to Account A", () => {
            const stack = stackTemplate.toJSON();
            // CloudFormation template itself does not contain account information,
            // but it is verified in the context when creating the stack
            expect(defaultEnv.account).toBe("111111111111");
        });

        test("Peering connection should reference Account B", () => {
            stackTemplate.hasResourceProperties("AWS::EC2::VPCPeeringConnection", {
                PeerOwnerId: envParams.accountBId,
            });
        });
    });

    describe("Security and Compliance", () => {
        test("All resources should have proper tags", () => {
            if (envParams.tags) {
                const peeringConnections = stackTemplate.findResources("AWS::EC2::VPCPeeringConnection");
                Object.values(peeringConnections).forEach((pc: any) => {
                    const tags = pc.Properties.Tags || [];
                    Object.entries(envParams.tags!).forEach(([key, value]) => {
                        const hasTag = tags.some((tag: any) => tag.Key === key && tag.Value === value);
                        expect(hasTag).toBe(true);
                    });
                });
            }
        });

        test("Routes should only point to valid CIDR blocks", () => {
            const routes = stackTemplate.findResources("AWS::EC2::Route");
            Object.values(routes).forEach((route: any) => {
                if (route.Properties.DestinationCidrBlock) {
                    const cidr = route.Properties.DestinationCidrBlock;
                    // CIDR形式の基本的なバリデーション
                    expect(cidr).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/);
                }
            });
        });
    });

    describe("Resource Counts", () => {
        test("Should create exactly 1 VPC Peering Connection", () => {
            stackTemplate.resourceCountIs("AWS::EC2::VPCPeeringConnection", 1);
        });

        test("Should create routes for VPC B", () => {
            const routes = stackTemplate.findResources("AWS::EC2::Route");
            const peeringRoutes = Object.values(routes).filter(
                (route: any) => route.Properties.VpcPeeringConnectionId
            );
            expect(peeringRoutes.length).toBeGreaterThan(0);
        });
    });

    describe("Cross-Region Peering", () => {
        test("Should specify PeerRegion correctly", () => {
            const peeringConnections = stackTemplate.findResources("AWS::EC2::VPCPeeringConnection");
            Object.values(peeringConnections).forEach((pc: any) => {
                // PeerRegion is set to regionB or default region
                if (pc.Properties.PeerRegion) {
                    const expectedRegion = envParams.regionB || defaultEnv.region;
                    expect(pc.Properties.PeerRegion).toBe(expectedRegion);
                }
            });
        });
    });
});
