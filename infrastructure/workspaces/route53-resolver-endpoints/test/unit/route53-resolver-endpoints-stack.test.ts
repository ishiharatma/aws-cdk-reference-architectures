import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { Route53ResolverEndpointsStack } from 'lib/stacks/route53-resolver-endpoints-stack';
import { EnvParams } from 'lib/types/route53-resolver-endpoints-params';
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

/** Synthesise the stack with optional param overrides and return its template. */
function synthStack(overrides?: Partial<EnvParams>): Template {
    const app = new cdk.App();
    const stack = new Route53ResolverEndpointsStack(app, 'Route53ResolverEndpoints', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        terminationProtection: false,
        params: { ...envParams, ...overrides },
    });
    return Template.fromStack(stack);
}

describe('Route53ResolverEndpointsStack – topology', () => {
    let template: Template;

    beforeAll(() => {
        template = synthStack();
    });

    test('creates the verification VPC and the on-premises-role VPC', () => {
        template.resourceCountIs('AWS::EC2::VPC', 2);
        template.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.10.0.0/16' });
        template.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.20.0.0/16' });
    });

    test('connects the two VPCs with a peering connection', () => {
        template.resourceCountIs('AWS::EC2::VPCPeeringConnection', 1);
    });

    test('creates a private hosted zone for system.example.com associated with the verification VPC', () => {
        template.resourceCountIs('AWS::Route53::HostedZone', 1);
        template.hasResourceProperties('AWS::Route53::HostedZone', {
            Name: 'system.example.com.',
        });
        template.hasResourceProperties('AWS::Route53::RecordSet', {
            Name: 'app.system.example.com.',
            Type: 'A',
            ResourceRecords: ['10.10.200.10'],
        });
    });

    test('creates one inbound and one outbound Resolver endpoint, each with 2 IPs', () => {
        template.resourceCountIs('AWS::Route53Resolver::ResolverEndpoint', 2);
        template.hasResourceProperties('AWS::Route53Resolver::ResolverEndpoint', { Direction: 'INBOUND' });
        template.hasResourceProperties('AWS::Route53Resolver::ResolverEndpoint', { Direction: 'OUTBOUND' });

        const endpoints = template.findResources('AWS::Route53Resolver::ResolverEndpoint');
        for (const endpoint of Object.values(endpoints)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((endpoint as any).Properties.IpAddresses).toHaveLength(2);
        }
    });

    test('inbound endpoint switches to INBOUND_DELEGATION with Do53-only protocol when configured', () => {
        const delegationTemplate = synthStack({ inboundEndpointType: 'DELEGATION' });
        delegationTemplate.hasResourceProperties('AWS::Route53Resolver::ResolverEndpoint', {
            Direction: 'INBOUND_DELEGATION',
            Protocols: ['DO53'],
        });
        // The outbound endpoint is unaffected by the inbound toggle.
        delegationTemplate.hasResourceProperties('AWS::Route53Resolver::ResolverEndpoint', {
            Direction: 'OUTBOUND',
        });
    });

    test('creates a FORWARD rule for the on-premises domain, associated with the verification VPC', () => {
        template.resourceCountIs('AWS::Route53Resolver::ResolverRule', 1);
        template.hasResourceProperties('AWS::Route53Resolver::ResolverRule', {
            DomainName: 'onprem.example.com',
            RuleType: 'FORWARD',
        });
        template.resourceCountIs('AWS::Route53Resolver::ResolverRuleAssociation', 1);
    });

    test('creates the BIND9 on-premises DNS server and the verification test instance', () => {
        template.resourceCountIs('AWS::EC2::Instance', 2);
    });

    test('DNS resolution is enabled on the peering connection via a custom resource', () => {
        template.resourceCountIs('Custom::AWS', 1);
        const [customResource] = Object.values(template.findResources('Custom::AWS'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const createCall = JSON.stringify((customResource as any).Properties.Create);
        expect(createCall).toContain('modifyVpcPeeringConnectionOptions');
        expect(createCall).toContain('AllowDnsResolutionFromRemoteVpc\\":true');
    });
});

describe('Route53ResolverEndpointsStack – security groups', () => {
    test('resolver endpoint and BIND9 security groups scope DNS access to the peer VPC CIDR only', () => {
        const template = synthStack();
        const sgs = template.findResources('AWS::EC2::SecurityGroup');
        const dnsRules = Object.values(sgs).flatMap(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (sg: any) =>
                (sg.Properties.SecurityGroupIngress ?? []).filter(
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (rule: any) => rule.FromPort === 53,
                ),
        );
        expect(dnsRules.length).toBeGreaterThan(0);
        for (const rule of dnsRules) {
            expect(rule.CidrIp).not.toBe('0.0.0.0/0');
        }
    });
});
