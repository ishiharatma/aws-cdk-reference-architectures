import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * Configuration for a single VPC attachment to the Transit Gateway.
 */
export interface TransitGatewayVpcAttachmentConfig {
    /** Logical name for the attachment, used in construct ids and resource tags (e.g. "VpcA"). */
    readonly name: string;
    /** The VPC to attach to the Transit Gateway. */
    readonly vpc: ec2.IVpc;
    /**
     * Subnets that host the Transit Gateway elastic network interfaces.
     * Provide one subnet per Availability Zone. A small dedicated subnet is recommended
     * so that the routing domain of the attachment stays isolated from workload subnets.
     */
    readonly attachmentSubnets: ec2.ISubnet[];
    /**
     * Subnets whose route tables receive a route towards the Transit Gateway for every
     * other attached VPC's CIDR block.
     * @default - every public, private and isolated subnet of the VPC
     */
    readonly routableSubnets?: ec2.ISubnet[];
}

/**
 * Properties for {@link TransitGatewayConstruct}.
 */
export interface TransitGatewayConstructProps {
    readonly project: string;
    readonly environment: string;
    /**
     * Private Autonomous System Number for the Amazon side of a BGP session.
     * The range 64512-65534 is reserved for private use.
     * @default 64512
     */
    readonly amazonSideAsn?: number;
    /**
     * VPC attachments. At least two are required for the Transit Gateway to route traffic.
     */
    readonly attachments: TransitGatewayVpcAttachmentConfig[];
    /**
     * Whether DNS resolution is supported across the Transit Gateway.
     * @default true
     */
    readonly dnsSupport?: boolean;
}

/**
 * Transit Gateway Construct
 *
 * Creates a Transit Gateway that connects multiple VPCs in a full mesh through a single,
 * explicitly managed Transit Gateway route table.
 *
 * Design decisions:
 * - `defaultRouteTableAssociation` / `defaultRouteTablePropagation` are **disabled**. Routing
 *   is managed through one dedicated route table that every attachment is both associated
 *   with and propagates into. This keeps the routing domain auditable and is the pattern
 *   recommended for production over relying on the implicit default route table.
 * - Each attachment lives in caller-supplied dedicated subnets so the Transit Gateway ENIs
 *   do not share a route table with workloads.
 * - VPC route table entries are scoped to each *other* attached VPC's CIDR (no broad
 *   supernet route), so the blast radius of a misconfiguration is a single VPC.
 *
 * @example
 * new TransitGatewayConstruct(this, 'TransitGateway', {
 *   project, environment,
 *   attachments: [
 *     { name: 'VpcA', vpc: vpcA, attachmentSubnets: vpcA.selectSubnets({ subnetGroupName: 'Tgw' }).subnets },
 *     { name: 'VpcB', vpc: vpcB, attachmentSubnets: vpcB.selectSubnets({ subnetGroupName: 'Tgw' }).subnets },
 *   ],
 * });
 */
export class TransitGatewayConstruct extends Construct {
    /** The underlying Transit Gateway. */
    public readonly transitGateway: ec2.CfnTransitGateway;
    /** The single Transit Gateway route table shared by every attachment. */
    public readonly routeTable: ec2.CfnTransitGatewayRouteTable;
    /** VPC attachments keyed by their configured `name`. */
    public readonly attachments: Record<string, ec2.CfnTransitGatewayVpcAttachment> = {};

    /**
     * Creates the Transit Gateway, its shared route table, and the per-VPC attachment wiring.
     * @param scope parent construct
     * @param id construct id
     * @param props Transit Gateway configuration
     */
    constructor(scope: Construct, id: string, props: TransitGatewayConstructProps) {
        super(scope, id);

        if (props.attachments.length < 2) {
            throw new Error('TransitGatewayConstruct requires at least two VPC attachments.');
        }

        const names = props.attachments.map((a) => a.name);
        if (new Set(names).size !== names.length) {
            throw new Error(`TransitGatewayConstruct attachment names must be unique: ${names.join(', ')}`);
        }

        const namePrefix = [props.project, props.environment].join('/');
        const dnsSupport = (props.dnsSupport ?? true) ? 'enable' : 'disable';

        this.transitGateway = new ec2.CfnTransitGateway(this, 'TransitGateway', {
            amazonSideAsn: props.amazonSideAsn ?? 64512,
            autoAcceptSharedAttachments: 'disable',
            defaultRouteTableAssociation: 'disable',
            defaultRouteTablePropagation: 'disable',
            dnsSupport,
            multicastSupport: 'disable',
            vpnEcmpSupport: 'enable',
            description: `${namePrefix} multi-VPC Transit Gateway`,
            tags: [{ key: 'Name', value: `${namePrefix}/TransitGateway` }],
        });

        this.routeTable = new ec2.CfnTransitGatewayRouteTable(this, 'RouteTable', {
            transitGatewayId: this.transitGateway.ref,
            tags: [{ key: 'Name', value: `${namePrefix}/TransitGatewayRouteTable` }],
        });

        // One attachment + association + propagation per VPC.
        for (const attachment of props.attachments) {
            const vpcAttachment = new ec2.CfnTransitGatewayVpcAttachment(this, `${attachment.name}Attachment`, {
                transitGatewayId: this.transitGateway.ref,
                vpcId: attachment.vpc.vpcId,
                subnetIds: attachment.attachmentSubnets.map((subnet) => subnet.subnetId),
                options: { DnsSupport: dnsSupport },
                tags: [{ key: 'Name', value: `${namePrefix}/${attachment.name}Attachment` }],
            });
            this.attachments[attachment.name] = vpcAttachment;

            // Associate: traffic entering from this attachment is evaluated against the shared table.
            new ec2.CfnTransitGatewayRouteTableAssociation(this, `${attachment.name}Association`, {
                transitGatewayAttachmentId: vpcAttachment.ref,
                transitGatewayRouteTableId: this.routeTable.ref,
            });

            // Propagate: this VPC's CIDR is advertised into the shared table so the others can reach it.
            new ec2.CfnTransitGatewayRouteTablePropagation(this, `${attachment.name}Propagation`, {
                transitGatewayAttachmentId: vpcAttachment.ref,
                transitGatewayRouteTableId: this.routeTable.ref,
            });
        }

        // VPC route table entries: from every attached VPC towards every *other* attached
        // VPC's CIDR, next hop = Transit Gateway. Each route waits for this VPC's attachment.
        for (const source of props.attachments) {
            const targets = props.attachments.filter((target) => target.name !== source.name);
            const routableSubnets =
                source.routableSubnets ??
                [...source.vpc.publicSubnets, ...source.vpc.privateSubnets, ...source.vpc.isolatedSubnets];

            routableSubnets.forEach((subnet, subnetIndex) => {
                targets.forEach((target) => {
                    const route = new ec2.CfnRoute(
                        this,
                        `${source.name}To${target.name}Route${subnetIndex + 1}`,
                        {
                            routeTableId: subnet.routeTable.routeTableId,
                            destinationCidrBlock: target.vpc.vpcCidrBlock,
                            transitGatewayId: this.transitGateway.ref,
                        },
                    );
                    route.addResourceDependency(this.attachments[source.name]);
                });
            });
        }

        new cdk.CfnOutput(this, 'TransitGatewayId', {
            value: this.transitGateway.ref,
            description: 'Transit Gateway ID',
        });
        new cdk.CfnOutput(this, 'TransitGatewayRouteTableId', {
            value: this.routeTable.ref,
            description: 'Transit Gateway route table ID',
        });
    }
}
