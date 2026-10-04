import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as nfw from 'aws-cdk-lib/aws-networkfirewall';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

export interface TgwNetworkFirewallInspectionStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/**
 * Centralized inspection with AWS Network Firewall behind a Transit Gateway.
 *
 *   spoke A / spoke B (private, no internet route of their own)
 *      -- 0.0.0.0/0 --> Transit Gateway (spoke route table)
 *      --> inspection VPC attachment (appliance mode)
 *      --> Network Firewall endpoint --> NAT gateway --> internet            (egress)
 *      --> Network Firewall endpoint --> Transit Gateway --> other spoke      (east-west)
 *
 * One firewall inspects both directions of both flows. The firewall policy allows only the configured
 * domains (HTTP host / TLS SNI) and, optionally, drops ICMP between the spokes.
 * One AZ keeps the reference cheap; production needs a firewall endpoint and NAT gateway per AZ.
 */
export class TgwNetworkFirewallInspectionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TgwNetworkFirewallInspectionStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const prefix = `${project}-${environment}-nfw`;

    // ---------------------------------------------------------------------------------------------
    // VPCs: two spokes without internet access of their own, and the inspection VPC
    // ---------------------------------------------------------------------------------------------
    const spokeVpc = (name: string, cidr: string) => new ec2.Vpc(this, name, {
      ipAddresses: ec2.IpAddresses.cidr(cidr),
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'workload', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 26 },
        { name: 'tgw', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 28 },
      ],
      restrictDefaultSecurityGroup: true,
    });
    const spokeA = spokeVpc('SpokeA', params.spokeACidr);
    const spokeB = spokeVpc('SpokeB', params.spokeBCidr);
    const inspection = new ec2.Vpc(this, 'Inspection', {
      ipAddresses: ec2.IpAddresses.cidr(params.inspectionCidr),
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 28 },
        { name: 'firewall', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 28 },
        { name: 'tgw', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 28 },
      ],
      restrictDefaultSecurityGroup: true,
    });
    const subnetOf = (vpc: ec2.Vpc, group: string) => vpc.selectSubnets({ subnetGroupName: group }).subnets[0];
    const inspectionPublic = subnetOf(inspection, 'public');
    const inspectionFirewall = subnetOf(inspection, 'firewall');
    const inspectionTgw = subnetOf(inspection, 'tgw');

    // ---------------------------------------------------------------------------------------------
    // Network Firewall: domain allow list (+ optional east-west ICMP drop), alert and flow logs
    // ---------------------------------------------------------------------------------------------
    const domainRules = new nfw.CfnRuleGroup(this, 'DomainAllowList', {
      ruleGroupName: `${prefix}-domain-allow`,
      type: 'STATEFUL',
      capacity: 100,
      ruleGroup: {
        ruleVariables: { ipSets: { HOME_NET: { definition: [params.homeNet] } } },
        rulesSource: {
          rulesSourceList: {
            generatedRulesType: 'ALLOWLIST',
            targetTypes: ['HTTP_HOST', 'TLS_SNI'],
            targets: params.allowedDomains,
          },
        },
      },
    });
    // East-west rules. `pass` is evaluated before the allow list's drops, so these flows are not caught by it.
    const eastWestRules = [
      ...params.eastWestAllowedTcpPorts.map((port, i) =>
        `pass tcp ${params.spokeACidr} any <> ${params.spokeBCidr} ${port} (msg:"east-west TCP ${port} allowed"; sid:${1000100 + i}; rev:1;)`),
      ...(params.blockEastWestIcmp
        ? [`drop icmp ${params.spokeACidr} any <> ${params.spokeBCidr} any (msg:"east-west ICMP blocked"; sid:1000001; rev:1;)`]
        : []),
    ];
    const ruleGroupArns = [domainRules.attrRuleGroupArn];
    if (eastWestRules.length > 0) {
      const eastWest = new nfw.CfnRuleGroup(this, 'EastWestRules', {
        ruleGroupName: `${prefix}-east-west`,
        type: 'STATEFUL',
        capacity: 20,
        ruleGroup: { rulesSource: { rulesString: eastWestRules.join('\n') } },
      });
      ruleGroupArns.push(eastWest.attrRuleGroupArn);
    }

    const policy = new nfw.CfnFirewallPolicy(this, 'Policy', {
      firewallPolicyName: `${prefix}-policy`,
      firewallPolicy: {
        statelessDefaultActions: ['aws:forward_to_sfe'],
        statelessFragmentDefaultActions: ['aws:forward_to_sfe'],
        statefulRuleGroupReferences: ruleGroupArns.map((resourceArn) => ({ resourceArn })),
      },
    });
    const firewall = new nfw.CfnFirewall(this, 'Firewall', {
      firewallName: `${prefix}-firewall`,
      firewallPolicyArn: policy.attrFirewallPolicyArn,
      vpcId: inspection.vpcId,
      subnetMappings: [{ subnetId: inspectionFirewall.subnetId }],
      deleteProtection: false,
    });
    const firewallEndpointId = cdk.Fn.select(1, cdk.Fn.split(':', cdk.Fn.select(0, firewall.attrEndpointIds)));

    const alertLogs = new logs.LogGroup(this, 'AlertLogs', {
      logGroupName: `/${prefix}/alert`,
      retention: params.logRetentionDays as number as logs.RetentionDays,
      removalPolicy,
    });
    const flowLogs = new logs.LogGroup(this, 'FlowLogs', {
      logGroupName: `/${prefix}/flow`,
      retention: params.logRetentionDays as number as logs.RetentionDays,
      removalPolicy,
    });
    new nfw.CfnLoggingConfiguration(this, 'Logging', {
      firewallArn: firewall.attrFirewallArn,
      loggingConfiguration: {
        logDestinationConfigs: [
          { logType: 'ALERT', logDestinationType: 'CloudWatchLogs', logDestination: { logGroup: alertLogs.logGroupName } },
          { logType: 'FLOW', logDestinationType: 'CloudWatchLogs', logDestination: { logGroup: flowLogs.logGroupName } },
        ],
      },
    });

    // ---------------------------------------------------------------------------------------------
    // Transit Gateway: two route tables so every flow is forced through the inspection VPC
    // ---------------------------------------------------------------------------------------------
    const tgw = new ec2.CfnTransitGateway(this, 'Tgw', {
      description: `${prefix} transit gateway`,
      amazonSideAsn: 64512,
      defaultRouteTableAssociation: 'disable',
      defaultRouteTablePropagation: 'disable',
      dnsSupport: 'enable',
      tags: [{ key: 'Name', value: `${prefix}-tgw` }],
    });
    const attach = (name: string, vpc: ec2.Vpc, applianceMode: boolean) => new ec2.CfnTransitGatewayVpcAttachment(this, `${name}Attachment`, {
      transitGatewayId: tgw.ref,
      vpcId: vpc.vpcId,
      subnetIds: [subnetOf(vpc, 'tgw').subnetId],
      // Appliance mode keeps both directions of a flow on the same AZ's firewall endpoint.
      options: applianceMode ? { ApplianceModeSupport: 'enable' } : undefined,
      tags: [{ key: 'Name', value: `${prefix}-${name.toLowerCase()}` }],
    });
    const attachA = attach('SpokeA', spokeA, false);
    const attachB = attach('SpokeB', spokeB, false);
    const attachInspection = attach('Inspection', inspection, true);

    const spokeRouteTable = new ec2.CfnTransitGatewayRouteTable(this, 'SpokeRouteTable', {
      transitGatewayId: tgw.ref,
      tags: [{ key: 'Name', value: `${prefix}-spokes` }],
    });
    const inspectionRouteTable = new ec2.CfnTransitGatewayRouteTable(this, 'InspectionRouteTable', {
      transitGatewayId: tgw.ref,
      tags: [{ key: 'Name', value: `${prefix}-inspection` }],
    });
    const associate = (id: string, attachment: ec2.CfnTransitGatewayVpcAttachment, table: ec2.CfnTransitGatewayRouteTable) =>
      new ec2.CfnTransitGatewayRouteTableAssociation(this, id, {
        transitGatewayAttachmentId: attachment.ref,
        transitGatewayRouteTableId: table.ref,
      });
    associate('AssociateSpokeA', attachA, spokeRouteTable);
    associate('AssociateSpokeB', attachB, spokeRouteTable);
    associate('AssociateInspection', attachInspection, inspectionRouteTable);

    // Spokes: everything goes to the inspection VPC (east-west included, so spoke-to-spoke is inspected too)
    const spokeDefault = new ec2.CfnTransitGatewayRoute(this, 'SpokesDefaultToInspection', {
      transitGatewayRouteTableId: spokeRouteTable.ref,
      destinationCidrBlock: '0.0.0.0/0',
      transitGatewayAttachmentId: attachInspection.ref,
    });
    // Inspection: the way back to each spoke
    const toSpokeA = new ec2.CfnTransitGatewayRoute(this, 'InspectionToSpokeA', {
      transitGatewayRouteTableId: inspectionRouteTable.ref,
      destinationCidrBlock: params.spokeACidr,
      transitGatewayAttachmentId: attachA.ref,
    });
    const toSpokeB = new ec2.CfnTransitGatewayRoute(this, 'InspectionToSpokeB', {
      transitGatewayRouteTableId: inspectionRouteTable.ref,
      destinationCidrBlock: params.spokeBCidr,
      transitGatewayAttachmentId: attachB.ref,
    });

    // ---------------------------------------------------------------------------------------------
    // VPC routes
    // ---------------------------------------------------------------------------------------------
    const spokeRoutes: ec2.CfnRoute[] = [];
    for (const [name, vpc, attachment] of [['SpokeA', spokeA, attachA], ['SpokeB', spokeB, attachB]] as const) {
      const route = new ec2.CfnRoute(this, `${name}DefaultToTgw`, {
        routeTableId: subnetOf(vpc, 'workload').routeTable.routeTableId,
        destinationCidrBlock: '0.0.0.0/0',
        transitGatewayId: tgw.ref,
      });
      route.addDependency(attachment);
      spokeRoutes.push(route);
    }

    // Inspection VPC, traffic from the Transit Gateway goes to the firewall endpoint
    const tgwToFirewall = new ec2.CfnRoute(this, 'InspectionTgwToFirewall', {
      routeTableId: inspectionTgw.routeTable.routeTableId,
      destinationCidrBlock: '0.0.0.0/0',
      vpcEndpointId: firewallEndpointId,
    });
    // Internet egress: firewall -> NAT gateway; east-west and return traffic: firewall -> Transit Gateway
    const eip = new ec2.CfnEIP(this, 'NatEip', { domain: 'vpc' });
    const nat = new ec2.CfnNatGateway(this, 'Nat', {
      subnetId: inspectionPublic.subnetId,
      allocationId: eip.attrAllocationId,
      tags: [{ key: 'Name', value: `${prefix}-nat` }],
    });
    new ec2.CfnRoute(this, 'FirewallDefaultToNat', {
      routeTableId: inspectionFirewall.routeTable.routeTableId,
      destinationCidrBlock: '0.0.0.0/0',
      natGatewayId: nat.ref,
    });
    for (const [name, cidr, attachment] of [['A', params.spokeACidr, attachInspection], ['B', params.spokeBCidr, attachInspection]] as const) {
      const route = new ec2.CfnRoute(this, `FirewallToSpoke${name}`, {
        routeTableId: inspectionFirewall.routeTable.routeTableId,
        destinationCidrBlock: cidr,
        transitGatewayId: tgw.ref,
      });
      route.addDependency(attachment);
      // Return traffic from the internet comes back through the NAT gateway and must pass the firewall again
      new ec2.CfnRoute(this, `PublicToSpoke${name}ViaFirewall`, {
        routeTableId: inspectionPublic.routeTable.routeTableId,
        destinationCidrBlock: cidr,
        vpcEndpointId: firewallEndpointId,
      });
    }

    // ---------------------------------------------------------------------------------------------
    // Test instances (SSM only, no SSH, no public IP): A is the client, B runs a tiny HTTP server
    // ---------------------------------------------------------------------------------------------
    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    const testInstance = (name: string, vpc: ec2.Vpc, userData?: ec2.UserData) => {
      const sg = new ec2.SecurityGroup(this, `${name}Sg`, { vpc, description: `${name} test instance`, allowAllOutbound: true });
      sg.addIngressRule(ec2.Peer.ipv4(params.homeNet), ec2.Port.tcp(8080), 'HTTP test from the spokes');
      sg.addIngressRule(ec2.Peer.ipv4(params.homeNet), ec2.Port.allIcmp(), 'ICMP from the spokes (the firewall decides, not the security group)');
      const instance = new ec2.Instance(this, name, {
        vpc,
        vpcSubnets: { subnetGroupName: 'workload' },
        instanceType: new ec2.InstanceType('t4g.nano'),
        machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
        securityGroup: sg,
        role,
        requireImdsv2: true,
        blockDevices: [{ deviceName: '/dev/xvda', volume: ec2.BlockDeviceVolume.ebs(8, { encrypted: true }) }],
        userData,
      });
      // The SSM agent needs the egress path (spoke -> TGW -> firewall -> NAT) before it can register.
      [...spokeRoutes, spokeDefault, toSpokeA, toSpokeB, tgwToFirewall, nat].forEach((dep) => instance.node.addDependency(dep));
      return instance;
    };
    const serverData = ec2.UserData.forLinux();
    serverData.addCommands(
      'mkdir -p /srv/www && echo "{\\"server\\":\\"spoke-b\\"}" > /srv/www/index.html',
      'cd /srv/www && nohup python3 -m http.server 8080 > /var/log/http-server.log 2>&1 &',
    );
    const client = testInstance('ClientA', spokeA);
    const server = testInstance('ServerB', spokeB, serverData);

    // ---------------------------------------------------------------------------------------------
    // Outputs (used by test-inspection.sh)
    // ---------------------------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ClientInstanceId', { value: client.instanceId });
    new cdk.CfnOutput(this, 'ServerInstanceId', { value: server.instanceId });
    new cdk.CfnOutput(this, 'ServerPrivateIp', { value: server.instancePrivateIp });
    new cdk.CfnOutput(this, 'AlertLogGroup', { value: alertLogs.logGroupName });
    new cdk.CfnOutput(this, 'FlowLogGroup', { value: flowLogs.logGroupName });
    new cdk.CfnOutput(this, 'FirewallName', { value: `${prefix}-firewall` });
  }
}
