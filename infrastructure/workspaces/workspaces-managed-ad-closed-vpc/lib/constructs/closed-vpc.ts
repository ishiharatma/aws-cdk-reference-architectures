import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { NetworkParams, SubnetSpec } from 'lib/types';

/** Properties of {@link ClosedVpc}. */
export interface ClosedVpcProps {
  /** Prefix for Name tags (e.g. `wsdev-dev`). */
  readonly namePrefix: string;
  readonly network: NetworkParams;
  readonly removalPolicy: cdk.RemovalPolicy;
}

/** A group of subnets that share one route table. */
export interface SubnetTier {
  readonly subnets: ec2.ISubnet[];
  readonly routeTable: ec2.CfnRouteTable;
  readonly cidrs: string[];
}

/**
 * VPC without an internet gateway or NAT.
 *
 * - Subnets are L1 `CfnSubnet`s pinned with `AvailabilityZoneId`, because WorkSpaces supports
 *   only specific AZ IDs and the L2 `Subnet` accepts AZ names only.
 * - Each tier gets one route table with the local route only. The Transit Gateway tier is
 *   created now so that a later TGW attachment does not need re-addressing.
 * - Interface endpoints live in their own tier and accept HTTPS from the VPC CIDR only.
 */
export class ClosedVpc extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly workspaces: SubnetTier;
  public readonly directory: SubnetTier;
  public readonly endpoints: SubnetTier;
  public readonly management: SubnetTier;
  public readonly transitGateway: SubnetTier;
  public readonly endpointSecurityGroup: ec2.ISecurityGroup;

  /**

   * Define the resources.

   *
   * @param scope - Parent construct
   * @param id - Construct ID
   * @param props - Construct properties
   */
  constructor(scope: Construct, id: string, props: ClosedVpcProps) {
    super(scope, id);

    const { network, namePrefix } = props;

    // No subnetConfiguration -> no subnets, no IGW, no NAT from the L2 construct.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${namePrefix}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr(network.vpcCidr),
      subnetConfiguration: [],
      natGateways: 0,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      restrictDefaultSecurityGroup: true,
    });
    this.vpc = vpc;

    this.workspaces = this.createTier('Workspaces', 'ws', network.workspacesSubnets, namePrefix);
    this.directory = this.createTier('Directory', 'ad', network.directorySubnets, namePrefix);
    this.endpoints = this.createTier('Endpoints', 'vpce', network.endpointSubnets, namePrefix);
    this.management = this.createTier(
      'Management',
      'manage',
      network.managementSubnets,
      namePrefix
    );
    this.transitGateway = this.createTier(
      'TransitGateway',
      'tgw',
      network.transitGatewaySubnets,
      namePrefix
    );

    // ------------------------------------------------------------------
    // Flow logs (all traffic, CloudWatch Logs)
    // ------------------------------------------------------------------
    const flowLogGroup = new logs.LogGroup(this, 'FlowLogGroup', {
      retention: network.flowLogRetention,
      removalPolicy: props.removalPolicy,
    });
    new ec2.FlowLog(this, 'FlowLog', {
      resourceType: ec2.FlowLogResourceType.fromVpc(vpc),
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // ------------------------------------------------------------------
    // VPC endpoints
    // ------------------------------------------------------------------
    // S3 gateway endpoint: no hourly charge. Used by the SSM agent (updates, Run Command
    // output) on the management instance and by WorkSpaces users for package downloads.
    new ec2.CfnVPCEndpoint(this, 'S3GatewayEndpoint', {
      vpcId: vpc.vpcId,
      serviceName: `com.amazonaws.${cdk.Stack.of(this).region}.s3`,
      vpcEndpointType: 'Gateway',
      routeTableIds: [this.workspaces, this.management].map((tier) => tier.routeTable.ref),
    });

    const endpointSecurityGroup = new ec2.SecurityGroup(this, 'EndpointSecurityGroup', {
      vpc,
      description: 'Interface VPC endpoints: HTTPS from inside the VPC only',
      allowAllOutbound: false,
    });
    endpointSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(network.vpcCidr),
      ec2.Port.tcp(443),
      'HTTPS from the VPC'
    );

    for (const service of network.interfaceEndpoints) {
      new ec2.InterfaceVpcEndpoint(this, `Endpoint-${service}`, {
        vpc,
        service: new ec2.InterfaceVpcEndpointAwsService(service),
        subnets: { subnets: this.endpoints.subnets },
        securityGroups: [endpointSecurityGroup],
        privateDnsEnabled: true,
        open: false,
      });
    }
    this.endpointSecurityGroup = endpointSecurityGroup;
  }

  /** Create one subnet tier: a route table (local route only) and its subnets pinned by AZ ID. */
  private createTier(
    id: string,
    label: string,
    specs: SubnetSpec[],
    namePrefix: string
  ): SubnetTier {
    if (specs.length === 0) {
      throw new Error(`Subnet tier "${label}" has no subnets`);
    }

    const routeTable = new ec2.CfnRouteTable(this, `${id}RouteTable`, {
      vpcId: this.vpc.vpcId,
      tags: [{ key: 'Name', value: `${namePrefix}-rtb-${label}` }],
    });

    const subnets = specs.map((spec) => {
      const cfnSubnet = new ec2.CfnSubnet(this, `Subnet-${spec.name}`, {
        vpcId: this.vpc.vpcId,
        cidrBlock: spec.cidr,
        availabilityZoneId: spec.availabilityZoneId,
        mapPublicIpOnLaunch: false,
        tags: [{ key: 'Name', value: `${namePrefix}-${spec.name}` }],
      });
      new ec2.CfnSubnetRouteTableAssociation(this, `RouteTableAssociation-${spec.name}`, {
        subnetId: cfnSubnet.ref,
        routeTableId: routeTable.ref,
      });
      return ec2.Subnet.fromSubnetAttributes(this, `Imported-${spec.name}`, {
        subnetId: cfnSubnet.ref,
        // The AZ name is resolved from the AZ ID at deploy time.
        availabilityZone: cfnSubnet.attrAvailabilityZone,
        routeTableId: routeTable.ref,
        ipv4CidrBlock: spec.cidr,
      });
    });

    return { subnets, routeTable, cidrs: specs.map((spec) => spec.cidr) };
  }
}
