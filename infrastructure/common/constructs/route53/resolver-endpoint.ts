import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as route53resolver from 'aws-cdk-lib/aws-route53resolver';
import { Construct } from 'constructs';
import { C_RESOURCE } from '../../constants';

/**
 * Direction of a Route 53 Resolver endpoint.
 *
 * `INBOUND_DELEGATION` is the endpoint category introduced in June 2025 that lets an
 * on-premises (or other external) DNS server delegate a subdomain to a Route 53 private
 * hosted zone via NS records, instead of relying on conditional forwarding rules.
 * @see https://aws.amazon.com/about-aws/whats-new/2025/06/amazon-route-53-resolver-endpoints-dns-delegation-private-hosted-zones
 */
export type ResolverEndpointDirection = 'INBOUND' | 'OUTBOUND' | 'INBOUND_DELEGATION';

/**
 * Properties for {@link ResolverEndpointConstruct}.
 */
export interface ResolverEndpointConstructProps {
    readonly project: string;
    readonly environment: string;
    readonly vpc: ec2.IVpc;
    /** Endpoint direction. `INBOUND_DELEGATION` forces the Do53-only protocol restriction. */
    readonly direction: ResolverEndpointDirection;
    /**
     * Subnets that host the endpoint's elastic network interfaces.
     * Route 53 Resolver requires at least two, in different Availability Zones.
     */
    readonly subnets: ec2.ISubnet[];
    /** Logical name used for tagging, the Resolver endpoint `Name`, and CfnOutput ids. */
    readonly name: string;
    /**
     * CIDR blocks allowed to send (inbound endpoint) or that the endpoint is allowed to
     * reach back (outbound endpoint) DNS traffic on port 53/tcp+udp.
     */
    readonly allowedCidrs: string[];
    /**
     * Assign a deterministic static IP address (one per subnet, at a fixed host offset)
     * instead of letting Route 53 auto-assign one from the subnet.
     *
     * Required when other resources need to reference the endpoint's IP addresses at
     * synth time - e.g. an NS+glue `AWS::Route53::RecordSet` pointing at an
     * `INBOUND_DELEGATION` endpoint's IPs, or a README that documents the IPs an
     * on-premises resolver should delegate to.
     * @default false
     */
    readonly useStaticIps?: boolean;
    /**
     * Host offset (from the subnet's network address) used to compute each static IP
     * when {@link useStaticIps} is true. Must fall inside the subnet's usable host range.
     * @default 10
     */
    readonly staticIpHostOffset?: number;
}

/**
 * Computes the IPv4 address at `hostOffset` from the network address of `cidr`.
 * Used to derive a deterministic Resolver endpoint IP from a subnet CIDR that is a
 * literal string at synth time (true for any subnet of a VPC created directly by CDK).
 */
function staticIpInCidr(cidr: string, hostOffset: number): string {
    const [base] = cidr.split('/');
    const octets = base.split('.').map(Number);
    let asInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
    asInt = (asInt + hostOffset) >>> 0;
    return [24, 16, 8, 0].map((shift) => (asInt >>> shift) & 255).join('.');
}

/**
 * Route 53 Resolver Endpoint Construct
 *
 * Wraps `AWS::Route53Resolver::ResolverEndpoint` plus the dedicated security group that
 * every endpoint direction requires (inbound/outbound rules must allow TCP and UDP on
 * port 53 - see the CloudFormation reference for `SecurityGroupIds`).
 *
 * @example
 * new ResolverEndpointConstruct(this, 'InboundEndpoint', {
 *   project, environment,
 *   vpc: verifyVpc.vpc,
 *   direction: 'INBOUND',
 *   subnets: verifyVpc.vpc.selectSubnets({ subnetGroupName: 'Resolver' }).subnets,
 *   name: 'Inbound',
 *   allowedCidrs: [onPremVpc.vpc.vpcCidrBlock],
 * });
 */
export class ResolverEndpointConstruct extends Construct {
    /** The underlying Resolver endpoint. */
    public readonly endpoint: route53resolver.CfnResolverEndpoint;
    /** Security group attached to the endpoint's network interfaces. */
    public readonly securityGroup: ec2.SecurityGroup;
    /**
     * Static IP addresses assigned to the endpoint, index-aligned with the `subnets` prop.
     * Only populated when `useStaticIps` is true.
     */
    public readonly ipAddresses: string[];

    constructor(scope: Construct, id: string, props: ResolverEndpointConstructProps) {
        super(scope, id);

        if (props.subnets.length < 2) {
            throw new Error(
                `ResolverEndpointConstruct '${props.name}' requires at least 2 subnets (Route 53 Resolver minimum); got ${props.subnets.length}.`,
            );
        }

        const namePrefix = [props.project, props.environment].join('/');
        const isDelegationInbound = props.direction === 'INBOUND_DELEGATION';
        const useStaticIps = props.useStaticIps ?? false;
        const hostOffset = props.staticIpHostOffset ?? 10;

        this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
            vpc: props.vpc,
            description: `Route 53 Resolver ${props.direction} endpoint (${props.name}) security group`,
            allowAllOutbound: true,
        });
        for (const cidr of props.allowedCidrs) {
            this.securityGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(53), `Allow DNS (TCP) from ${cidr}`);
            this.securityGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.udp(53), `Allow DNS (UDP) from ${cidr}`);
        }

        this.ipAddresses = useStaticIps
            ? props.subnets.map((subnet) => staticIpInCidr(subnet.ipv4CidrBlock, hostOffset))
            : [];

        this.endpoint = new route53resolver.CfnResolverEndpoint(this, C_RESOURCE, {
            direction: props.direction,
            ipAddresses: props.subnets.map((subnet, index) => ({
                subnetId: subnet.subnetId,
                ...(useStaticIps ? { ip: this.ipAddresses[index] } : {}),
            })),
            securityGroupIds: [this.securityGroup.securityGroupId],
            // A delegation inbound endpoint only supports the Do53 protocol. Note the exact
            // casing: the Route 53 Resolver API's enum value is "Do53", not "DO53".
            protocols: isDelegationInbound ? ['Do53'] : undefined,
            resolverEndpointType: 'IPV4',
            // Resolver endpoint names may only contain letters, numbers, hyphens,
            // underscores and spaces - no slashes.
            name: `${namePrefix.replace(/\//g, '-')}-${props.name}`.slice(0, 64),
        });

        new cdk.CfnOutput(this, 'ResolverEndpointId', {
            value: this.endpoint.attrResolverEndpointId,
            description: `Resolver endpoint ID (${props.direction}) for ${props.name}`,
        });
        if (useStaticIps) {
            new cdk.CfnOutput(this, 'ResolverEndpointIps', {
                value: this.ipAddresses.join(','),
                description: `Static IP addresses for the ${props.name} resolver endpoint`,
            });
        }
    }
}
