import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { Route53PhzDelegationStack } from 'lib/stacks/route53-phz-delegation-stack';
import { EnvParams } from 'lib/types/route53-phz-delegation-params';
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

/** Synthesise the stack and return its template. */
function synthStack(): Template {
    const app = new cdk.App();
    const stack = new Route53PhzDelegationStack(app, 'Route53PhzDelegation', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        terminationProtection: false,
        params: envParams,
    });
    return Template.fromStack(stack);
}

describe('Route53PhzDelegationStack – topology', () => {
    let template: Template;

    beforeAll(() => {
        template = synthStack();
    });

    test('creates four VPCs with the expected CIDRs', () => {
        template.resourceCountIs('AWS::EC2::VPC', 4);
        for (const cidr of ['10.0.0.0/16', '10.1.0.0/16', '10.2.0.0/16', '10.3.0.0/16']) {
            template.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: cidr });
        }
    });

    test('joins all four VPCs with one Transit Gateway', () => {
        template.resourceCountIs('AWS::EC2::TransitGateway', 1);
        template.resourceCountIs('AWS::EC2::TransitGatewayRouteTable', 1);
        template.resourceCountIs('AWS::EC2::TransitGatewayVpcAttachment', 4);
        template.resourceCountIs('AWS::EC2::TransitGatewayRouteTableAssociation', 4);
        template.resourceCountIs('AWS::EC2::TransitGatewayRouteTablePropagation', 4);
    });

    test('every subnet is isolated: no Internet Gateway, NAT Gateway, or public IP', () => {
        template.resourceCountIs('AWS::EC2::InternetGateway', 0);
        template.resourceCountIs('AWS::EC2::NatGateway', 0);
        const instances = template.findResources('AWS::EC2::Instance');
        for (const instance of Object.values(instances)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((instance as any).Properties.NetworkInterfaces?.[0]?.AssociatePublicIpAddress).not.toBe(true);
        }
    });

    test('creates the SSM/SSM Messages/EC2 Messages interface endpoints for Hub and OnPrem VPCs', () => {
        const interfaceEndpoints = template.findResources('AWS::EC2::VPCEndpoint', {
            Properties: { VpcEndpointType: 'Interface' },
        });
        expect(Object.keys(interfaceEndpoints)).toHaveLength(6); // 3 services x 2 VPCs (Hub, OnPrem)
    });

    test('creates three private hosted zones, one per zone-owning VPC', () => {
        template.resourceCountIs('AWS::Route53::HostedZone', 3);
        template.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'system.example.com.' });
        template.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'dev.system.example.com.' });
        template.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'stg.system.example.com.' });
    });

    test('creates 4 Resolver endpoints: Hub inbound + outbound, Dev + Stg delegation inbound', () => {
        template.resourceCountIs('AWS::Route53Resolver::ResolverEndpoint', 4);
        template.hasResourceProperties('AWS::Route53Resolver::ResolverEndpoint', { Direction: 'INBOUND' });
        template.hasResourceProperties('AWS::Route53Resolver::ResolverEndpoint', { Direction: 'OUTBOUND' });

        const delegationEndpoints = template.findResources('AWS::Route53Resolver::ResolverEndpoint', {
            Properties: { Direction: 'INBOUND_DELEGATION' },
        });
        expect(Object.keys(delegationEndpoints)).toHaveLength(2);
        for (const endpoint of Object.values(delegationEndpoints)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((endpoint as any).Properties.Protocols).toEqual(['Do53']);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((endpoint as any).Properties.IpAddresses).toHaveLength(2);
        }
    });

    test('creates 2 DELEGATE resolver rules on the Hub outbound endpoint, associated with HubVpc', () => {
        template.resourceCountIs('AWS::Route53Resolver::ResolverRule', 2);
        template.hasResourceProperties('AWS::Route53Resolver::ResolverRule', {
            RuleType: 'DELEGATE',
            DelegationRecord: 'dev.system.example.com',
        });
        template.hasResourceProperties('AWS::Route53Resolver::ResolverRule', {
            RuleType: 'DELEGATE',
            DelegationRecord: 'stg.system.example.com',
        });
        template.resourceCountIs('AWS::Route53Resolver::ResolverRuleAssociation', 2);

        const rules = template.findResources('AWS::Route53Resolver::ResolverRule');
        for (const rule of Object.values(rules)) {
            // DELEGATE rules must not specify TargetIps.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((rule as any).Properties.TargetIps).toBeUndefined();
        }
    });

    test('the parent zone carries NS + glue A records delegating dev./stg. to their endpoint IPs', () => {
        template.hasResourceProperties('AWS::Route53::RecordSet', {
            Name: 'dev.system.example.com.',
            Type: 'NS',
            ResourceRecords: [Match.stringLikeRegexp('^ns-dev-1\\.system\\.example\\.com\\.$'), Match.stringLikeRegexp('^ns-dev-2\\.system\\.example\\.com\\.$')],
        });
        template.hasResourceProperties('AWS::Route53::RecordSet', {
            Name: 'stg.system.example.com.',
            Type: 'NS',
        });

        const aRecords = template.findResources('AWS::Route53::RecordSet', {
            Properties: { Type: 'A' },
        });
        const glueNames = Object.values(aRecords)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((r: any) => r.Properties.Name)
            .filter((name: string) => name.startsWith('ns-dev-') || name.startsWith('ns-stg-'));
        expect(glueNames).toHaveLength(4); // ns-dev-1, ns-dev-2, ns-stg-1, ns-stg-2
    });

    test('creates the BIND9 on-premises forwarder and the Hub test instance', () => {
        template.resourceCountIs('AWS::EC2::Instance', 2);
    });
});

describe('Route53PhzDelegationStack – security groups', () => {
    test('no security group opens DNS (port 53) to 0.0.0.0/0', () => {
        const template = synthStack();
        const sgs = template.findResources('AWS::EC2::SecurityGroup');
        for (const sg of Object.values(sgs)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ingress: any[] = (sg as any).Properties.SecurityGroupIngress ?? [];
            for (const rule of ingress) {
                if (rule.FromPort === 53) {
                    expect(rule.CidrIp).not.toBe('0.0.0.0/0');
                }
            }
        }
    });
});
