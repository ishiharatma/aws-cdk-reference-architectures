/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Environment } from '@common/parameters/environments';
import { TransitGatewayConstruct } from '@common/constructs/vpc/transit-gateway';
import { TransitGatewayStack } from 'lib/stacks/transit-gateway-stack';
import { EnvParams } from 'lib/types/transit-gateway-params';
import { params } from 'parameters/environments';
import '../parameters';

const defaultEnv = { account: '123456789012', region: 'us-east-1' };
const projectName = 'TestProject';
const envName: Environment = Environment.TEST;
const loaded = params[envName];
if (!loaded) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams: EnvParams = loaded;

/** Synthesise the stack and return its template, with optional allowlist overrides. */
function synthStack(overrides?: { allowedIps?: string[]; allowedIpv6s?: string[] }): Template {
    const app = new cdk.App();
    const stack = new TransitGatewayStack(app, 'TransitGateway', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        terminationProtection: false,
        params: envParams,
        allowedIps: overrides?.allowedIps ?? ['192.0.2.10'],
        allowedIpv6s: overrides?.allowedIpv6s ?? [],
    });
    return Template.fromStack(stack);
}

describe('TransitGatewayStack – core topology', () => {
    let template: Template;

    beforeAll(() => {
        template = synthStack();
    });

    test('creates the three VPCs', () => {
        template.resourceCountIs('AWS::EC2::VPC', 3);
        for (const cidr of ['10.0.0.0/16', '10.1.0.0/16', '10.2.0.0/16']) {
            template.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: cidr });
        }
    });

    test('creates one Transit Gateway with explicit (disabled) default routing', () => {
        template.resourceCountIs('AWS::EC2::TransitGateway', 1);
        template.hasResourceProperties('AWS::EC2::TransitGateway', {
            AmazonSideAsn: 64512,
            DefaultRouteTableAssociation: 'disable',
            DefaultRouteTablePropagation: 'disable',
            DnsSupport: 'enable',
        });
    });

    test('creates a single shared Transit Gateway route table with an attachment/association/propagation per VPC', () => {
        template.resourceCountIs('AWS::EC2::TransitGatewayRouteTable', 1);
        template.resourceCountIs('AWS::EC2::TransitGatewayVpcAttachment', 3);
        template.resourceCountIs('AWS::EC2::TransitGatewayRouteTableAssociation', 3);
        template.resourceCountIs('AWS::EC2::TransitGatewayRouteTablePropagation', 3);
    });

    test('each Transit Gateway attachment uses the dedicated /28 Tgw subnets', () => {
        // 2 AZs => 2 subnet ids per attachment
        const attachments = template.findResources('AWS::EC2::TransitGatewayVpcAttachment');
        expect(Object.keys(attachments)).toHaveLength(3);
        for (const attachment of Object.values(attachments)) {
            expect((attachment as any).Properties.SubnetIds).toHaveLength(2);
        }
    });

    test('adds VPC routes towards the Transit Gateway for every other VPC CIDR', () => {
        // 3 source VPCs x (2 public + 2 isolated route tables) x 2 peer CIDRs = 24
        const routes = template.findResources('AWS::EC2::Route', {
            Properties: { TransitGatewayId: Match.anyValue() },
        });
        expect(Object.keys(routes)).toHaveLength(24);

        // Destination is each peer VPC's CIDR, referenced via the VPC's CfnAttr.
        const destinations = Object.values(routes).map(
            (r: any) => JSON.stringify(r.Properties.DestinationCidrBlock),
        );
        for (const vpcLogicalIdPrefix of ['VpcA', 'VpcB', 'VpcC']) {
            expect(
                destinations.some((d) => d.includes(vpcLogicalIdPrefix) && d.includes('CidrBlock')),
            ).toBe(true);
        }
        // No TGW-bound route should be a default route.
        expect(destinations).not.toContain('"0.0.0.0/0"');
    });

    test('each TGW-bound route depends on its own VPC attachment', () => {
        const routes = template.findResources('AWS::EC2::Route', {
            Properties: { TransitGatewayId: Match.anyValue() },
        });
        for (const route of Object.values(routes)) {
            const deps: string[] = (route as any).DependsOn ?? [];
            expect(deps.some((d) => d.includes('Attachment'))).toBe(true);
        }
    });

    test('creates one test instance per VPC', () => {
        template.resourceCountIs('AWS::EC2::Instance', 3);
    });
});

describe('TransitGatewayStack – security groups', () => {
    test('operator IP is allowed on SSH as a /32 and the mesh supernet on ICMP + SSH', () => {
        const template = synthStack({ allowedIps: ['198.51.100.7'] });

        template.hasResourceProperties('AWS::EC2::SecurityGroup', {
            SecurityGroupIngress: Match.arrayWith([
                Match.objectLike({
                    CidrIp: '198.51.100.7/32',
                    FromPort: 22,
                    ToPort: 22,
                    IpProtocol: 'tcp',
                }),
            ]),
        });
        template.hasResourceProperties('AWS::EC2::SecurityGroup', {
            SecurityGroupIngress: Match.arrayWith([
                Match.objectLike({ CidrIp: '10.0.0.0/8', IpProtocol: 'icmp' }),
            ]),
        });
        template.hasResourceProperties('AWS::EC2::SecurityGroup', {
            SecurityGroupIngress: Match.arrayWith([
                Match.objectLike({ CidrIp: '10.0.0.0/8', FromPort: 22, ToPort: 22, IpProtocol: 'tcp' }),
            ]),
        });
    });

    test('a bare IP without a mask is normalised to /32', () => {
        const template = synthStack({ allowedIps: ['203.0.113.5/32'] });
        template.hasResourceProperties('AWS::EC2::SecurityGroup', {
            SecurityGroupIngress: Match.arrayWith([
                Match.objectLike({ CidrIp: '203.0.113.5/32', FromPort: 22 }),
            ]),
        });
    });

    test('no security group opens SSH to the world', () => {
        const template = synthStack();
        const sgs = template.findResources('AWS::EC2::SecurityGroup');
        for (const sg of Object.values(sgs)) {
            const ingress: any[] = (sg as any).Properties.SecurityGroupIngress ?? [];
            for (const rule of ingress) {
                if (rule.FromPort === 22) {
                    expect(rule.CidrIp).not.toBe('0.0.0.0/0');
                }
            }
        }
    });
});

describe('TransitGatewayConstruct – validation', () => {
    /** Build `count` throwaway VPCs, each with a single isolated "Tgw" subnet group. */
    function makeVpcs(stack: cdk.Stack, count: number): ec2.Vpc[] {
        return Array.from({ length: count }, (_, i) =>
            new ec2.Vpc(stack, `Vpc${i}`, {
                ipAddresses: ec2.IpAddresses.cidr(`10.${i}.0.0/16`),
                maxAzs: 2,
                natGateways: 0,
                subnetConfiguration: [
                    { name: 'Tgw', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 28 },
                ],
            }),
        );
    }

    test('throws when fewer than two attachments are supplied', () => {
        const app = new cdk.App();
        const stack = new cdk.Stack(app, 'S', { env: defaultEnv });
        const [vpc] = makeVpcs(stack, 1);
        expect(
            () =>
                new TransitGatewayConstruct(stack, 'Tgw', {
                    project: projectName,
                    environment: envName,
                    attachments: [
                        { name: 'VpcA', vpc, attachmentSubnets: vpc.isolatedSubnets },
                    ],
                }),
        ).toThrow('at least two VPC attachments');
    });

    test('throws when attachment names are not unique', () => {
        const app = new cdk.App();
        const stack = new cdk.Stack(app, 'S', { env: defaultEnv });
        const [vpcA, vpcB] = makeVpcs(stack, 2);
        expect(
            () =>
                new TransitGatewayConstruct(stack, 'Tgw', {
                    project: projectName,
                    environment: envName,
                    attachments: [
                        { name: 'Dup', vpc: vpcA, attachmentSubnets: vpcA.isolatedSubnets },
                        { name: 'Dup', vpc: vpcB, attachmentSubnets: vpcB.isolatedSubnets },
                    ],
                }),
        ).toThrow('names must be unique');
    });

    test('synthesises for a valid two-VPC mesh', () => {
        const app = new cdk.App();
        const stack = new cdk.Stack(app, 'S', { env: defaultEnv });
        const [vpcA, vpcB] = makeVpcs(stack, 2);
        expect(
            () =>
                new TransitGatewayConstruct(stack, 'Tgw', {
                    project: projectName,
                    environment: envName,
                    attachments: [
                        { name: 'VpcA', vpc: vpcA, attachmentSubnets: vpcA.isolatedSubnets },
                        { name: 'VpcB', vpc: vpcB, attachmentSubnets: vpcB.isolatedSubnets },
                    ],
                }),
        ).not.toThrow();
        const template = Template.fromStack(stack);
        template.resourceCountIs('AWS::EC2::TransitGateway', 1);
        // 2 VPCs x 2 isolated subnets x 1 peer CIDR = 4
        template.resourceCountIs('AWS::EC2::Route', 4);
    });
});
