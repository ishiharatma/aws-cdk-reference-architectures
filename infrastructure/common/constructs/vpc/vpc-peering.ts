import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as cr from 'aws-cdk-lib/custom-resources';

export interface VpcPeeringProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: string;
    readonly vpc: ec2.IVpc;
    readonly peerVpc: ec2.IVpc;
    readonly targetSubnets?: ec2.ISubnet[];
    readonly targetPeerSubnets?: ec2.ISubnet[];
    readonly localSecurityGroup?: ec2.ISecurityGroup;
    readonly peerSecurityGroup?: ec2.ISecurityGroup;
}

export class VpcPeering extends Construct {
    readonly vpcPeeringConnection: ec2.CfnVPCPeeringConnection;
    readonly localSecurityGroup: ec2.ISecurityGroup;
    readonly peeringSecurityGroup: ec2.ISecurityGroup;

    constructor(scope: Construct, id: string, props: VpcPeeringProps) {
        super(scope, id);

        // Check VPC CIDR blocks do not overlap
        if (props.vpc.vpcCidrBlock === props.peerVpc.vpcCidrBlock) {
            throw new Error(`VPC CIDR blocks overlap: ${props.vpc.vpcCidrBlock} and ${props.peerVpc.vpcCidrBlock}`);
        }

        // Create VPC Peering Connection
        const vpcPeering = new ec2.CfnVPCPeeringConnection(this, 'VpcPeeringConnection', {
            vpcId: props.vpc.vpcId,
            peerVpcId: props.peerVpc.vpcId,
            tags: [
                {
                    key: 'Name',
                    value: [props.project,
                            props.environment,
                            "Peering",
                            props.vpc.vpcId,
                            "to",
                            props.peerVpc.vpcId].join('-'),
                },
            ],
        });
        this.vpcPeeringConnection = vpcPeering;

        // Enable DNS resolution over VPC Peering
        const onCreate: cr.AwsSdkCall = {
            service: 'EC2',
            action: 'modifyVpcPeeringConnectionOptions',
            parameters: {
                VpcPeeringConnectionId: vpcPeering.ref,
                AccepterPeeringConnectionOptions: {
                    AllowDnsResolutionFromRemoteVpc: true,
                },
                RequesterPeeringConnectionOptions: {
                    AllowDnsResolutionFromRemoteVpc: true
                }
            },
            region: props.env?.region,
            physicalResourceId: cr.PhysicalResourceId.of(`EnableVpcPeeringDnsResolution:${vpcPeering.ref}`),
        }
        const onUpdate = onCreate;
        const onDelete: cr.AwsSdkCall = {
            service: "EC2",
            action: "modifyVpcPeeringConnectionOptions",
            parameters: {
                VpcPeeringConnectionId: vpcPeering.ref,
                AccepterPeeringConnectionOptions: {
                    AllowDnsResolutionFromRemoteVpc: false,
                },
                RequesterPeeringConnectionOptions: {
                    AllowDnsResolutionFromRemoteVpc: false
                }
            },
        }
        new cr.AwsCustomResource(this, 'EnableVpcPeeringDnsResolution', {
        onUpdate,
        onCreate,
        onDelete,
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE}),
        });

        // Add routes to route tables in both VPCs
        if (props.targetSubnets) {
            props.targetSubnets.forEach((subnet, index) => {
                new ec2.CfnRoute(this, `VpcPeeringRouteToPeerVpc${index + 1}`, {
                    routeTableId: subnet.routeTable.routeTableId,
                    destinationCidrBlock: props.peerVpc.vpcCidrBlock,
                    vpcPeeringConnectionId: vpcPeering.ref,
                });
            });
        } else {
            const targetSubnets =
              (props.vpc.privateSubnets && props.vpc.privateSubnets.length > 0)
                ? props.vpc.privateSubnets
                : props.vpc.isolatedSubnets;
            targetSubnets.forEach((subnet, index) => {
                new ec2.CfnRoute(this, `VpcPeeringRouteToPeerVpc${index + 1}`, {
                    routeTableId: subnet.routeTable.routeTableId,
                    destinationCidrBlock: props.peerVpc.vpcCidrBlock,
                    vpcPeeringConnectionId: vpcPeering.ref,
                });
            });
        }

        if (props.targetPeerSubnets) {
            props.targetPeerSubnets.forEach((subnet, index) => {
                new ec2.CfnRoute(this, `VpcPeeringRouteToLocalVpc${index + 1}`, {
                    routeTableId: subnet.routeTable.routeTableId,
                    destinationCidrBlock: props.vpc.vpcCidrBlock,
                    vpcPeeringConnectionId: vpcPeering.ref,
                });
            });
        } else {
            const targetPeerSubnets =
              (props.peerVpc.privateSubnets && props.peerVpc.privateSubnets.length > 0)
                ? props.peerVpc.privateSubnets
                : props.peerVpc.isolatedSubnets;
            targetPeerSubnets.forEach((subnet, index) => {
                new ec2.CfnRoute(this, `VpcPeeringRouteToLocalVpc${index + 1}`, {
                    routeTableId: subnet.routeTable.routeTableId,
                    destinationCidrBlock: props.vpc.vpcCidrBlock,
                    vpcPeeringConnectionId: vpcPeering.ref,
                });
            });
        }
        if (props.localSecurityGroup) {
            // Allow traffic from peer VPC to local security group
            props.localSecurityGroup.addIngressRule(
                ec2.Peer.ipv4(props.peerVpc.vpcCidrBlock),
                ec2.Port.allTraffic(),
                `Allow all traffic from peer VPC [${props.peerVpc.vpcId}]`
            );
            this.localSecurityGroup = props.localSecurityGroup;
        } else {
            this.localSecurityGroup = new ec2.SecurityGroup(this, 'LocalVpcPeeringSecurityGroup', {
                vpc: props.vpc,
                description: `Security group for VPC Peering traffic from peer VPC[${props.peerVpc.vpcId}]`,
                allowAllOutbound: true,
            });

            this.localSecurityGroup.addIngressRule(
                ec2.Peer.ipv4(props.peerVpc.vpcCidrBlock),
                ec2.Port.allTraffic(),
                `Allow all traffic from peer VPC [${props.peerVpc.vpcId}]`
            );
        }

        if (props.peerSecurityGroup) {
            // Allow traffic from local VPC to peer security group
            props.peerSecurityGroup.addIngressRule(
                ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
                ec2.Port.allTraffic(),
                `Allow all traffic from local VPC [${props.vpc.vpcId}]`
            );
            this.peeringSecurityGroup = props.peerSecurityGroup;
        } else {
            this.peeringSecurityGroup = new ec2.SecurityGroup(this, 'PeerVpcPeeringSecurityGroup', {
                vpc: props.peerVpc,
                description: `Security group for VPC Peering traffic from local VPC[${props.vpc.vpcId}]`,
                allowAllOutbound: true,
            });

            this.peeringSecurityGroup.addIngressRule(
                ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
                ec2.Port.allTraffic(),
                `Allow all traffic from local VPC [${props.vpc.vpcId}]`
            );
        }

    }
}