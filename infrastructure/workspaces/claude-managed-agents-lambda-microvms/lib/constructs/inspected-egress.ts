import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as nfw from 'aws-cdk-lib/aws-networkfirewall';
import { Construct } from 'constructs';

export interface InspectedEgressProps {
  readonly prefix: string;
  readonly vpcCidr: string;
  /** HTTP host / TLS SNI patterns the firewall lets through. A leading dot matches subdomains. */
  readonly allowedDomains: string[];
  readonly logRetention: logs.RetentionDays;
  readonly removalPolicy: cdk.RemovalPolicy;
}

/**
 * Outbound-only path for MicroVMs with a domain allow list.
 *
 *   MicroVM -- VPC egress connector --> workload subnet
 *           -- 0.0.0.0/0 --> Network Firewall endpoint (firewall subnet)
 *           -- 0.0.0.0/0 --> NAT gateway (public subnet) --> internet gateway
 *
 * The public subnet routes the workload subnet CIDR back through the firewall endpoint so both directions of a
 * flow pass the same stateful engine. One AZ keeps the reference cheap; production needs a firewall
 * endpoint and NAT gateway per AZ.
 */
export class InspectedEgress extends Construct {
  public readonly connector: lambda.CfnNetworkConnector;
  public readonly alertLogGroup: logs.ILogGroup;
  public readonly flowLogGroup: logs.ILogGroup;
  public readonly firewall: nfw.CfnFirewall;

  constructor(scope: Construct, id: string, props: InspectedEgressProps) {
    super(scope, id);
    const { prefix } = props;

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 28 },
        { name: 'firewall', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 28 },
        { name: 'workload', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 27 },
      ],
      restrictDefaultSecurityGroup: true,
    });
    const subnetOf = (group: string) => vpc.selectSubnets({ subnetGroupName: group }).subnets[0];
    const publicSubnet = subnetOf('public');
    const firewallSubnet = subnetOf('firewall');
    const workloadSubnet = subnetOf('workload');

    // Domain allow list. Everything else on HTTP/TLS is dropped by the stateful engine.
    const domainRules = new nfw.CfnRuleGroup(this, 'DomainAllowList', {
      ruleGroupName: `${prefix}-domain-allow`,
      type: 'STATEFUL',
      capacity: 100,
      ruleGroup: {
        ruleVariables: { ipSets: { HOME_NET: { definition: [props.vpcCidr] } } },
        rulesSource: {
          rulesSourceList: {
            generatedRulesType: 'ALLOWLIST',
            targetTypes: ['HTTP_HOST', 'TLS_SNI'],
            targets: props.allowedDomains,
          },
        },
      },
    });
    const policy = new nfw.CfnFirewallPolicy(this, 'Policy', {
      firewallPolicyName: `${prefix}-policy`,
      firewallPolicy: {
        statelessDefaultActions: ['aws:forward_to_sfe'],
        statelessFragmentDefaultActions: ['aws:forward_to_sfe'],
        statefulRuleGroupReferences: [{ resourceArn: domainRules.attrRuleGroupArn }],
      },
    });
    this.firewall = new nfw.CfnFirewall(this, 'Firewall', {
      firewallName: `${prefix}-firewall`,
      firewallPolicyArn: policy.attrFirewallPolicyArn,
      vpcId: vpc.vpcId,
      subnetMappings: [{ subnetId: firewallSubnet.subnetId }],
      deleteProtection: false,
    });
    const firewallEndpointId = cdk.Fn.select(1, cdk.Fn.split(':', cdk.Fn.select(0, this.firewall.attrEndpointIds)));

    this.alertLogGroup = new logs.LogGroup(this, 'AlertLogs', {
      logGroupName: `/${prefix}/firewall/alert`,
      retention: props.logRetention,
      removalPolicy: props.removalPolicy,
    });
    this.flowLogGroup = new logs.LogGroup(this, 'FlowLogs', {
      logGroupName: `/${prefix}/firewall/flow`,
      retention: props.logRetention,
      removalPolicy: props.removalPolicy,
    });
    new nfw.CfnLoggingConfiguration(this, 'Logging', {
      firewallArn: this.firewall.attrFirewallArn,
      loggingConfiguration: {
        logDestinationConfigs: [
          { logType: 'ALERT', logDestinationType: 'CloudWatchLogs', logDestination: { logGroup: this.alertLogGroup.logGroupName } },
          { logType: 'FLOW', logDestinationType: 'CloudWatchLogs', logDestination: { logGroup: this.flowLogGroup.logGroupName } },
        ],
      },
    });

    // Routes: workload -> firewall -> NAT -> IGW, and the return path back through the firewall
    const eip = new ec2.CfnEIP(this, 'NatEip', { domain: 'vpc' });
    const nat = new ec2.CfnNatGateway(this, 'Nat', {
      subnetId: publicSubnet.subnetId,
      allocationId: eip.attrAllocationId,
      tags: [{ key: 'Name', value: `${prefix}-nat` }],
    });
    const workloadToFirewall = new ec2.CfnRoute(this, 'WorkloadDefaultToFirewall', {
      routeTableId: workloadSubnet.routeTable.routeTableId,
      destinationCidrBlock: '0.0.0.0/0',
      vpcEndpointId: firewallEndpointId,
    });
    const firewallToNat = new ec2.CfnRoute(this, 'FirewallDefaultToNat', {
      routeTableId: firewallSubnet.routeTable.routeTableId,
      destinationCidrBlock: '0.0.0.0/0',
      natGatewayId: nat.ref,
    });
    const publicToWorkload = new ec2.CfnRoute(this, 'PublicToWorkloadViaFirewall', {
      routeTableId: publicSubnet.routeTable.routeTableId,
      // Not the VPC CIDR: the route table already holds a local route for it. A more specific destination is allowed.
      destinationCidrBlock: workloadSubnet.ipv4CidrBlock,
      vpcEndpointId: firewallEndpointId,
    });

    // The MicroVM never receives inbound connections through this path, so the group has no ingress rule.
    const securityGroup = new ec2.SecurityGroup(this, 'ConnectorSecurityGroup', {
      vpc,
      description: 'Outbound HTTPS only for Claude worker MicroVMs',
      allowAllOutbound: false,
    });
    securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS to the internet, filtered by Network Firewall');

    // A VPC_EGRESS connector needs a role Lambda can assume to manage ENIs in the subnets.
    const operatorRole = new iam.Role(this, 'ConnectorOperatorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Assumed by Lambda to manage ENIs in the MicroVM egress subnet',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')],
    });

    this.connector = new lambda.CfnNetworkConnector(this, 'Connector', {
      name: `${prefix}-egress`,
      operatorRole: operatorRole.roleArn,
      configuration: {
        vpcEgressConfiguration: {
          associatedComputeResourceTypes: ['MicroVm'],
          subnetIds: [workloadSubnet.subnetId],
          securityGroupIds: [securityGroup.securityGroupId],
          networkProtocol: 'IPv4',
        },
      },
    });
    // Connector ENIs are only useful once the whole path exists.
    [workloadToFirewall, firewallToNat, publicToWorkload, nat].forEach((dep) => this.connector.node.addDependency(dep));
  }
}
