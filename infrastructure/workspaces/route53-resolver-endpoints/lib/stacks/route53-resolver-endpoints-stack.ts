import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53resolver from 'aws-cdk-lib/aws-route53resolver';
import { VpcConstruct } from '@common/constructs/vpc/vpc';
import { VpcPeering } from '@common/constructs/vpc/vpc-peering';
import { TestInstance } from '@common/constructs/ec2/ec2-testinstance';
import { ResolverEndpointConstruct } from '@common/constructs/route53/resolver-endpoint';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'lib/types/route53-resolver-endpoints-params';
import { bind9UserData } from 'src/bind9-userdata';

/**
 * Properties for {@link Route53ResolverEndpointsStack}.
 */
export interface Route53ResolverEndpointsStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
}

/**
 * Route 53 Resolver Inbound/Outbound Endpoints Stack
 *
 * - `VerifyVpc` owns the `system.example.com` private hosted zone plus both Resolver
 *   endpoints. The inbound endpoint's direction (`INBOUND` vs `INBOUND_DELEGATION`) is
 *   switched by `params.inboundEndpointType` - no code change required.
 * - `OnPremVpc` stands in for on-premises infrastructure: a BIND9 EC2 instance answers
 *   authoritatively for `onprem.example.com`.
 * - The two VPCs are joined with a simple VPC peering connection (DNS resolution enabled
 *   over the peering by the {@link VpcPeering} construct).
 * - A Resolver FORWARD rule associated with `VerifyVpc` sends `onprem.example.com` queries
 *   out through the outbound endpoint, across the peering, to the BIND9 instance.
 * - A test instance in `VerifyVpc` can `dig` both the private hosted zone record (answered
 *   locally by Route 53) and the on-premises record (forwarded over the peering).
 */
export class Route53ResolverEndpointsStack extends cdk.Stack {
    public readonly verifyVpc: VpcConstruct;
    public readonly onPremVpc: VpcConstruct;
    public readonly inboundEndpoint: ResolverEndpointConstruct;
    public readonly outboundEndpoint: ResolverEndpointConstruct;

    constructor(scope: Construct, id: string, props: Route53ResolverEndpointsStackProps) {
        super(scope, id, props);

        const prefix = [props.project, props.environment].join('/');
        const privateHostedZoneName = props.params.privateHostedZoneName ?? 'system.example.com';
        const onPremDomainName = props.params.onPremDomainName ?? 'onprem.example.com';
        const inboundDirection = props.params.inboundEndpointType === 'DELEGATION' ? 'INBOUND_DELEGATION' : 'INBOUND';

        // 1. Verification VPC and on-premises-role VPC.
        this.verifyVpc = new VpcConstruct(this, 'VerifyVpc', {
            project: props.project,
            environment: props.environment,
            config: props.params.verifyVpcConfig,
            prefix,
        });
        this.onPremVpc = new VpcConstruct(this, 'OnPremVpc', {
            project: props.project,
            environment: props.environment,
            config: props.params.onPremVpcConfig,
            prefix,
        });

        // 2. Connect the two VPCs with a simple peering connection. Routes are added for
        //    every subnet on both sides so the resolver endpoints and BIND9 instance can
        //    reach each other regardless of which subnet group they land in.
        const verifyRoutableSubnets = [...this.verifyVpc.vpc.publicSubnets, ...this.verifyVpc.vpc.isolatedSubnets];
        const onPremRoutableSubnets = [...this.onPremVpc.vpc.publicSubnets, ...this.onPremVpc.vpc.isolatedSubnets];
        new VpcPeering(this, 'VerifyToOnPremPeering', {
            project: props.project,
            environment: props.environment,
            vpc: this.verifyVpc.vpc,
            peerVpc: this.onPremVpc.vpc,
            targetSubnets: verifyRoutableSubnets,
            targetPeerSubnets: onPremRoutableSubnets,
        });

        // 3. On-premises-role BIND9 DNS server, authoritative for onPremDomainName.
        const onPremDnsSecurityGroup = new ec2.SecurityGroup(this, 'OnPremDnsServerSecurityGroup', {
            vpc: this.onPremVpc.vpc,
            description: `BIND9 DNS server security group (authoritative for ${onPremDomainName})`,
            allowAllOutbound: true,
        });
        onPremDnsSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(this.verifyVpc.vpc.vpcCidrBlock),
            ec2.Port.tcp(53),
            `Allow DNS (TCP) from ${this.verifyVpc.vpc.vpcCidrBlock}`,
        );
        onPremDnsSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(this.verifyVpc.vpc.vpcCidrBlock),
            ec2.Port.udp(53),
            `Allow DNS (UDP) from ${this.verifyVpc.vpc.vpcCidrBlock}`,
        );
        const onPremDnsServer = new TestInstance(this, 'OnPremDnsServer', {
            project: props.project,
            environment: props.environment,
            vpc: this.onPremVpc.vpc,
            targetSubnetType: ec2.SubnetType.PUBLIC,
            additionalSecurityGroups: [onPremDnsSecurityGroup],
            additionalUserData: bind9UserData(onPremDomainName),
        });

        // 4. Private hosted zone owned by VerifyVpc, with one demo record.
        const privateHostedZone = new route53.PrivateHostedZone(this, 'PrivateHostedZone', {
            zoneName: privateHostedZoneName,
            vpc: this.verifyVpc.vpc,
        });
        new route53.ARecord(this, 'AppRecord', {
            zone: privateHostedZone,
            recordName: 'app',
            target: route53.RecordTarget.fromIpAddresses('10.10.200.10'),
            comment: 'Demo record proving direct private hosted zone resolution.',
        });

        // 5. Resolver endpoints, both in VerifyVpc's dedicated "Resolver" subnet group.
        const resolverSubnets = this.verifyVpc.vpc.selectSubnets({ subnetGroupName: 'Resolver' }).subnets;

        this.inboundEndpoint = new ResolverEndpointConstruct(this, 'InboundEndpoint', {
            project: props.project,
            environment: props.environment,
            vpc: this.verifyVpc.vpc,
            direction: inboundDirection,
            subnets: resolverSubnets,
            name: 'Inbound',
            allowedCidrs: [this.onPremVpc.vpc.vpcCidrBlock],
            useStaticIps: true,
        });

        this.outboundEndpoint = new ResolverEndpointConstruct(this, 'OutboundEndpoint', {
            project: props.project,
            environment: props.environment,
            vpc: this.verifyVpc.vpc,
            direction: 'OUTBOUND',
            subnets: resolverSubnets,
            name: 'Outbound',
            allowedCidrs: [this.onPremVpc.vpc.vpcCidrBlock],
        });

        // 6. FORWARD rule: queries for onPremDomainName leave through the outbound endpoint
        //    towards the BIND9 instance, across the VPC peering connection.
        const onPremForwardRule = new route53resolver.CfnResolverRule(this, 'OnPremForwardRule', {
            domainName: onPremDomainName,
            ruleType: 'FORWARD',
            resolverEndpointId: this.outboundEndpoint.endpoint.attrResolverEndpointId,
            targetIps: [{ ip: onPremDnsServer.instance.instancePrivateIp, port: '53' }],
            name: `${props.project}-${props.environment}-onprem-forward`.slice(0, 64),
        });
        new route53resolver.CfnResolverRuleAssociation(this, 'OnPremForwardRuleAssociation', {
            resolverRuleId: onPremForwardRule.attrResolverRuleId,
            vpcId: this.verifyVpc.vpc.vpcId,
        });

        // 7. Test instance in VerifyVpc: dig app.<privateHostedZoneName> (local PHZ) and
        //    dig host1.<onPremDomainName> (forwarded over the outbound endpoint + peering).
        const verifyTestInstance = new TestInstance(this, 'VerifyTestInstance', {
            project: props.project,
            environment: props.environment,
            vpc: this.verifyVpc.vpc,
            targetSubnetType: ec2.SubnetType.PUBLIC,
        });

        new cdk.CfnOutput(this, 'PrivateHostedZoneId', {
            value: privateHostedZone.hostedZoneId,
            description: `Private hosted zone ID for ${privateHostedZoneName}`,
        });
        new cdk.CfnOutput(this, 'InboundEndpointDirection', {
            value: inboundDirection,
            description: 'Active inbound endpoint direction (params.inboundEndpointType)',
        });
        new cdk.CfnOutput(this, 'OnPremDnsServerPrivateIp', {
            value: onPremDnsServer.instance.instancePrivateIp,
            description: 'BIND9 on-premises-role DNS server private IP',
        });
        new cdk.CfnOutput(this, 'VerifyTestInstanceId', {
            value: verifyTestInstance.instance.instanceId,
            description: 'Test EC2 instance ID in VerifyVpc',
        });

        // Apply common tags.
        if (props.params.tags) {
            Object.entries(props.params.tags).forEach(([key, value]) => {
                cdk.Tags.of(this).add(key, value);
            });
        }
    }
}
