import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface VpcPeeringProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: string;
    readonly requesterVpc: ec2.IVpc;
    readonly requesterAccountId: string;

    readonly peeringAccountId: string;
    readonly peeringRegion: string;
    readonly peeringVpcCidr: string;
    readonly peerVpcIdParamName: string;
    readonly peerVpcParameterReadRoleArn: string;
    readonly peeringRoleName: string;

    readonly targetSubnets?: ec2.ISubnet[];
    readonly localSecurityGroup?: ec2.ISecurityGroup;
}
 
export class CrossAccountVpcPeering extends Construct {
    public readonly vpcPeeringConnection: ec2.CfnVPCPeeringConnection;
    public readonly vpcpeeringConnectionId: string;
    public readonly securityGroup: ec2.ISecurityGroup;
    public readonly peeringSecurityGroup: ec2.ISecurityGroup;

    constructor(scope: Construct, id: string, props: VpcPeeringProps) {
        super(scope, id);

        // Check VPC CIDR blocks do not overlap
        if (props.requesterVpc.vpcCidrBlock === props.peeringVpcCidr) {
            throw new Error(`VPC CIDR blocks overlap: ${props.requesterVpc.vpcCidrBlock} and ${props.peeringVpcCidr}`);
        }

        const getAccepterVpcId = new cr.AwsCustomResource(this, 'GetAccepterVpcId', {
            onUpdate: {
                service: 'SSM',
                action: 'getParameter',
                parameters: {
                Name: props.peerVpcIdParamName,
                },
                region: props.peeringRegion,
                physicalResourceId: cr.PhysicalResourceId.of('VpcCIdLookup'),
                assumedRoleArn: props.peerVpcParameterReadRoleArn,
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                actions: ['sts:AssumeRole'],
                resources: [props.peerVpcParameterReadRoleArn],
                }),
            ]),
        });

        const accepterVpcId = getAccepterVpcId.getResponseField('Parameter.Value');

        // Create VPC Peering Connection from VPC B (Account A) to VPC C (Account B)
        this.vpcPeeringConnection = new ec2.CfnVPCPeeringConnection(this, 'VpcBCPeeringConnection', {
        vpcId: props.requesterVpc.vpcId,
        peerVpcId: accepterVpcId,
        peerOwnerId: props.peeringAccountId,
        peerRegion: props.peeringRegion,
        peerRoleArn: `arn:aws:iam::${props.peeringAccountId}:role/${props.peeringRoleName}`,
        tags: [
            {
            key: 'Name',
            value: [props.project,
                    props.environment,
                    "Peering",
                    props.requesterVpc.vpcId,
                    "to",
                    accepterVpcId].join('-'),
            },
        ],
        });

        // Store the peering connection ID for use in other stacks
        this.vpcpeeringConnectionId = this.vpcPeeringConnection.ref;

        // Create VPC Peering Connection
        const vpcPeering = new ec2.CfnVPCPeeringConnection(this, 'VpcPeeringConnection', {
            vpcId: props.requesterVpc.vpcId,
            peerVpcId: accepterVpcId,
            tags: [
                {
                    key: 'Name',
                    value: [props.project,
                            props.environment,
                            "Peering",
                            props.requesterVpc.vpcId,
                            "to",
                            accepterVpcId].join('-'),
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
                    destinationCidrBlock: props.peeringVpcCidr,
                    vpcPeeringConnectionId: vpcPeering.ref,
                });
            });
        } else {
            const targetSubnets =
                (props.requesterVpc.privateSubnets && props.requesterVpc.privateSubnets.length > 0)
                ? props.requesterVpc.privateSubnets
                : props.requesterVpc.isolatedSubnets;
            targetSubnets.forEach((subnet, index) => {
                new ec2.CfnRoute(this, `VpcPeeringRouteToPeerVpc${index + 1}`, {
                    routeTableId: subnet.routeTable.routeTableId,
                    destinationCidrBlock: props.peeringVpcCidr,
                    vpcPeeringConnectionId: vpcPeering.ref,
                });
            });
        }

        if (props.localSecurityGroup) {
            // Allow traffic from peer VPC to local security group
            props.localSecurityGroup.addIngressRule(
                ec2.Peer.ipv4(props.peeringVpcCidr),
                ec2.Port.allTraffic(),
                `Allow all traffic from peer VPC [${accepterVpcId}]`
            );
            this.securityGroup = props.localSecurityGroup;
        } else {
            this.securityGroup = new ec2.SecurityGroup(this, 'LocalVpcPeeringSecurityGroup', {
                vpc: props.requesterVpc,
                description: `Security group for VPC Peering traffic from peer VPC[${accepterVpcId}]`,
                allowAllOutbound: true,
            });

            this.securityGroup.addIngressRule(
                ec2.Peer.ipv4(props.peeringVpcCidr),
                ec2.Port.allTraffic(),
                `Allow all traffic from peer VPC [${accepterVpcId}]`
            );
        }

    }
}