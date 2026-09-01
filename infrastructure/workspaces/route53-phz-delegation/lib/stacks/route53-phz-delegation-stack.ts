import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53resolver from 'aws-cdk-lib/aws-route53resolver';
import { VpcConstruct } from '@common/constructs/vpc/vpc';
import { TransitGatewayConstruct } from '@common/constructs/vpc/transit-gateway';
import { TestInstance } from '@common/constructs/ec2/ec2-testinstance';
import { ResolverEndpointConstruct } from '@common/constructs/route53/resolver-endpoint';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'lib/types/route53-phz-delegation-params';
import { bind9ForwarderUserData } from 'src/bind9-forwarder-userdata';

/**
 * Properties for {@link Route53PhzDelegationStack}.
 */
export interface Route53PhzDelegationStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
}

/**
 * Route 53 Private Hosted Zone Delegation Stack
 *
 * Four VPCs joined by one Transit Gateway:
 * - `HubVpc` owns the parent private hosted zone (`system.example.com`), a regular inbound
 *   Resolver endpoint (for queries arriving from on-premises), and an outbound Resolver
 *   endpoint carrying two `DELEGATE` rules that hand `dev.` and `stg.` subdomain queries to
 *   `DevVpc` / `StgVpc`.
 * - `DevVpc` / `StgVpc` each own one child private hosted zone and an `INBOUND_DELEGATION`
 *   Resolver endpoint. `HubVpc`'s parent zone carries NS + glue (`A`) records pointing at
 *   each child's delegation endpoint IPs, exactly as an on-premises delegation would.
 * - `OnPremVpc` stands in for on-premises infrastructure: a BIND9 EC2 instance forwards
 *   *only* `system.example.com` to `HubVpc`'s inbound endpoint - no per-child conditional
 *   forwarder is configured, which is the point of the June 2025 DNS delegation feature.
 * - A test instance in `HubVpc` can `dig` all three zones; the delegation chain resolves
 *   `dev.`/`stg.` queries transparently through the Resolver rules.
 * - Every subnet is `PRIVATE_ISOLATED` - there is no Internet Gateway or NAT Gateway
 *   anywhere. SSM Session Manager access to the test/BIND9 instances (in `HubVpc` and
 *   `OnPremVpc`) is provided by SSM/SSM Messages/EC2 Messages interface endpoints instead.
 */
export class Route53PhzDelegationStack extends cdk.Stack {
    public readonly hubVpc: VpcConstruct;
    public readonly devVpc: VpcConstruct;
    public readonly stgVpc: VpcConstruct;
    public readonly onPremVpc: VpcConstruct;

    /**
     * Provisions the four VPCs, the Transit Gateway that meshes them, the three private
     * hosted zones, the delegation chain (Resolver endpoints + DELEGATE rules + NS/glue
     * records), and the BIND9/test instances.
     * @param scope parent construct
     * @param id stack id
     * @param props stack configuration
     */
    constructor(scope: Construct, id: string, props: Route53PhzDelegationStackProps) {
        super(scope, id, props);

        const prefix = [props.project, props.environment].join('/');
        const parentZoneName = props.params.parentZoneName ?? 'system.example.com';
        const devZoneName = props.params.devZoneName ?? 'dev.system.example.com';
        const stgZoneName = props.params.stgZoneName ?? 'stg.system.example.com';

        // 1. Four VPCs.
        this.hubVpc = new VpcConstruct(this, 'HubVpc', {
            project: props.project,
            environment: props.environment,
            config: props.params.hubVpcConfig,
            prefix,
        });
        this.devVpc = new VpcConstruct(this, 'DevVpc', {
            project: props.project,
            environment: props.environment,
            config: props.params.devVpcConfig,
            prefix,
        });
        this.stgVpc = new VpcConstruct(this, 'StgVpc', {
            project: props.project,
            environment: props.environment,
            config: props.params.stgVpcConfig,
            prefix,
        });
        this.onPremVpc = new VpcConstruct(this, 'OnPremVpc', {
            project: props.project,
            environment: props.environment,
            config: props.params.onPremVpcConfig,
            prefix,
        });

        // SSM interface endpoints in the two VPCs that host an EC2 instance, so the
        // private-only instances below stay reachable via Session Manager with no
        // Internet Gateway / NAT Gateway anywhere in the stack.
        this.addSsmInterfaceEndpoints(this.hubVpc.vpc, 'Hub');
        this.addSsmInterfaceEndpoints(this.onPremVpc.vpc, 'OnPrem');

        // 2. Join all four VPCs with a single Transit Gateway (same pattern as the
        //    `transit-gateway` workspace: one shared TGW route table, dedicated "Tgw"
        //    attachment subnets, routes to every other VPC's CIDR on every isolated subnet).
        const definitions = [
            { name: 'Hub', construct: this.hubVpc },
            { name: 'Dev', construct: this.devVpc },
            { name: 'Stg', construct: this.stgVpc },
            { name: 'OnPrem', construct: this.onPremVpc },
        ];
        new TransitGatewayConstruct(this, 'TransitGateway', {
            project: props.project,
            environment: props.environment,
            amazonSideAsn: props.params.amazonSideAsn,
            attachments: definitions.map(({ name, construct }) => ({
                name,
                vpc: construct.vpc,
                attachmentSubnets: construct.vpc.selectSubnets({ subnetGroupName: 'Tgw' }).subnets,
                routableSubnets: construct.vpc.isolatedSubnets,
            })),
        });

        // 3. Private hosted zones, one per VPC, each associated with its own VPC only.
        const parentZone = new route53.PrivateHostedZone(this, 'ParentZone', {
            zoneName: parentZoneName,
            vpc: this.hubVpc.vpc,
        });
        const devZone = new route53.PrivateHostedZone(this, 'DevZone', {
            zoneName: devZoneName,
            vpc: this.devVpc.vpc,
        });
        const stgZone = new route53.PrivateHostedZone(this, 'StgZone', {
            zoneName: stgZoneName,
            vpc: this.stgVpc.vpc,
        });
        new route53.ARecord(this, 'DevAppRecord', {
            zone: devZone,
            recordName: 'app',
            target: route53.RecordTarget.fromIpAddresses('10.1.200.10'),
            comment: 'Demo record proving direct resolution once inside DevVpc\'s own zone.',
        });
        new route53.ARecord(this, 'StgAppRecord', {
            zone: stgZone,
            recordName: 'app',
            target: route53.RecordTarget.fromIpAddresses('10.2.200.10'),
            comment: 'Demo record proving direct resolution once inside StgVpc\'s own zone.',
        });

        // 4. Resolver endpoints.
        //    HubVpc: a regular inbound endpoint (on-premises -> Hub) and an outbound endpoint
        //    (Hub -> Dev/Stg, carrying the DELEGATE rules below).
        const hubResolverSubnets = this.hubVpc.vpc.selectSubnets({ subnetGroupName: 'Resolver' }).subnets;
        const hubInboundEndpoint = new ResolverEndpointConstruct(this, 'HubInboundEndpoint', {
            project: props.project,
            environment: props.environment,
            vpc: this.hubVpc.vpc,
            direction: 'INBOUND',
            subnets: hubResolverSubnets,
            name: 'HubInbound',
            allowedCidrs: [this.onPremVpc.vpc.vpcCidrBlock],
            useStaticIps: true,
        });
        const hubOutboundEndpoint = new ResolverEndpointConstruct(this, 'HubOutboundEndpoint', {
            project: props.project,
            environment: props.environment,
            vpc: this.hubVpc.vpc,
            direction: 'OUTBOUND',
            subnets: hubResolverSubnets,
            name: 'HubOutbound',
            allowedCidrs: [this.devVpc.vpc.vpcCidrBlock, this.stgVpc.vpc.vpcCidrBlock],
        });

        //    DevVpc / StgVpc: delegation inbound endpoints, reachable only from HubVpc's
        //    outbound endpoint. Static IPs so the parent zone's glue records below are
        //    known at synth time.
        const devInboundDelegationEndpoint = new ResolverEndpointConstruct(this, 'DevInboundDelegationEndpoint', {
            project: props.project,
            environment: props.environment,
            vpc: this.devVpc.vpc,
            direction: 'INBOUND_DELEGATION',
            subnets: this.devVpc.vpc.selectSubnets({ subnetGroupName: 'Resolver' }).subnets,
            name: 'DevInboundDelegation',
            allowedCidrs: [this.hubVpc.vpc.vpcCidrBlock],
            useStaticIps: true,
        });
        const stgInboundDelegationEndpoint = new ResolverEndpointConstruct(this, 'StgInboundDelegationEndpoint', {
            project: props.project,
            environment: props.environment,
            vpc: this.stgVpc.vpc,
            direction: 'INBOUND_DELEGATION',
            subnets: this.stgVpc.vpc.selectSubnets({ subnetGroupName: 'Resolver' }).subnets,
            name: 'StgInboundDelegation',
            allowedCidrs: [this.hubVpc.vpc.vpcCidrBlock],
            useStaticIps: true,
        });

        // 5. One DELEGATE rule on HubVpc's outbound endpoint, keyed on the PARENT zone name.
        //    Per AWS's own delegation tutorial, an "in-zone" delegation (the NS + glue records
        //    for the child live inside the parent zone, as they do here) uses a single
        //    delegation rule whose delegationRecord is the parent zone - not one rule per
        //    child. Resolver watches every NS response returned while resolving names under
        //    that parent zone and, for any of them, hands the query to this outbound endpoint;
        //    it is the NS + glue records below (not a second rule) that make Dev vs. Stg
        //    resolve to different targets.
        const parentDelegateRule = new route53resolver.CfnResolverRule(this, 'ParentDelegateRule', {
            ruleType: 'DELEGATE',
            // DELEGATE rules identify their domain via delegationRecord only - the API
            // rejects a rule that also sets domainName (RSLVR-00724).
            delegationRecord: parentZoneName,
            resolverEndpointId: hubOutboundEndpoint.endpoint.attrResolverEndpointId,
            name: `${props.project}-${props.environment}-parent-delegate`.slice(0, 64),
        });
        new route53resolver.CfnResolverRuleAssociation(this, 'ParentDelegateRuleAssociation', {
            resolverRuleId: parentDelegateRule.attrResolverRuleId,
            vpcId: this.hubVpc.vpc.vpcId,
        });

        // 6. NS + glue (A) records in the parent zone, pointing at each child's delegation
        //    endpoint IPs - the same mechanism a public zone uses to delegate a subdomain,
        //    applied here to private hosted zones via the delegation endpoints' static IPs.
        const devNsHostnames = devInboundDelegationEndpoint.ipAddresses.map(
            (_, index) => `ns-dev-${index + 1}.${parentZoneName}`,
        );
        new route53.RecordSet(this, 'DevNsRecord', {
            zone: parentZone,
            recordName: `dev.${parentZoneName}`,
            recordType: route53.RecordType.NS,
            target: route53.RecordTarget.fromValues(...devNsHostnames.map((host) => `${host}.`)),
        });
        devInboundDelegationEndpoint.ipAddresses.forEach((ip, index) => {
            new route53.ARecord(this, `DevNsGlueRecord${index + 1}`, {
                zone: parentZone,
                recordName: `ns-dev-${index + 1}`,
                target: route53.RecordTarget.fromIpAddresses(ip),
                comment: `Glue record for ${devNsHostnames[index]} -> DevVpc delegation endpoint`,
            });
        });

        const stgNsHostnames = stgInboundDelegationEndpoint.ipAddresses.map(
            (_, index) => `ns-stg-${index + 1}.${parentZoneName}`,
        );
        new route53.RecordSet(this, 'StgNsRecord', {
            zone: parentZone,
            recordName: `stg.${parentZoneName}`,
            recordType: route53.RecordType.NS,
            target: route53.RecordTarget.fromValues(...stgNsHostnames.map((host) => `${host}.`)),
        });
        stgInboundDelegationEndpoint.ipAddresses.forEach((ip, index) => {
            new route53.ARecord(this, `StgNsGlueRecord${index + 1}`, {
                zone: parentZone,
                recordName: `ns-stg-${index + 1}`,
                target: route53.RecordTarget.fromIpAddresses(ip),
                comment: `Glue record for ${stgNsHostnames[index]} -> StgVpc delegation endpoint`,
            });
        });

        // 7. On-premises-role BIND9 forwarder: forwards only system.example.com to HubVpc's
        //    inbound endpoint. No per-child conditional forwarder - the DELEGATE rules above
        //    carry dev./stg. queries the rest of the way transparently.
        const onPremDnsSecurityGroup = new ec2.SecurityGroup(this, 'OnPremDnsServerSecurityGroup', {
            vpc: this.onPremVpc.vpc,
            description: 'BIND9 on-premises-role DNS forwarder security group',
            allowAllOutbound: true,
        });
        onPremDnsSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(this.hubVpc.vpc.vpcCidrBlock),
            ec2.Port.tcp(53),
            `Allow DNS (TCP) from ${this.hubVpc.vpc.vpcCidrBlock}`,
        );
        onPremDnsSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(this.hubVpc.vpc.vpcCidrBlock),
            ec2.Port.udp(53),
            `Allow DNS (UDP) from ${this.hubVpc.vpc.vpcCidrBlock}`,
        );
        const onPremDnsForwarder = new TestInstance(this, 'OnPremDnsForwarder', {
            project: props.project,
            environment: props.environment,
            vpc: this.onPremVpc.vpc,
            targetSubnetGroupName: 'Private',
            additionalSecurityGroups: [onPremDnsSecurityGroup],
            additionalUserData: bind9ForwarderUserData(parentZoneName, hubInboundEndpoint.ipAddresses),
        });

        // 8. Test instance in HubVpc: dig all three zones.
        const hubTestInstance = new TestInstance(this, 'HubTestInstance', {
            project: props.project,
            environment: props.environment,
            vpc: this.hubVpc.vpc,
            targetSubnetGroupName: 'Private',
        });

        new cdk.CfnOutput(this, 'ParentZoneId', {
            value: parentZone.hostedZoneId,
            description: `Private hosted zone ID for ${parentZoneName}`,
        });
        new cdk.CfnOutput(this, 'OnPremDnsForwarderPrivateIp', {
            value: onPremDnsForwarder.instance.instancePrivateIp,
            description: 'BIND9 on-premises-role forwarder private IP',
        });
        new cdk.CfnOutput(this, 'HubTestInstanceId', {
            value: hubTestInstance.instance.instanceId,
            description: 'Test EC2 instance ID in HubVpc',
        });

        // Apply common tags.
        if (props.params.tags) {
            Object.entries(props.params.tags).forEach(([key, value]) => {
                cdk.Tags.of(this).add(key, value);
            });
        }
    }

    /**
     * Creates the SSM, SSM Messages, and EC2 Messages interface endpoints (in the "Private"
     * subnet group) that Session Manager needs to reach an instance with no Internet Gateway
     * or NAT Gateway. Ingress is scoped to the VPC's own CIDR on 443/tcp only.
     * @param vpc the VPC to add the endpoints to
     * @param idPrefix construct id prefix, unique per VPC (e.g. "Hub", "OnPrem")
     */
    private addSsmInterfaceEndpoints(vpc: ec2.IVpc, idPrefix: string): void {
        const securityGroup = new ec2.SecurityGroup(this, `${idPrefix}SsmEndpointsSecurityGroup`, {
            vpc,
            description: `SSM interface endpoints security group for ${idPrefix}Vpc`,
            allowAllOutbound: true,
        });
        securityGroup.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(443),
            `Allow HTTPS from ${vpc.vpcCidrBlock} for SSM interface endpoints`,
        );

        const services: [string, ec2.InterfaceVpcEndpointAwsService][] = [
            ['Ssm', ec2.InterfaceVpcEndpointAwsService.SSM],
            ['SsmMessages', ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES],
            ['Ec2Messages', ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES],
        ];
        for (const [name, service] of services) {
            vpc.addInterfaceEndpoint(`${idPrefix}${name}Endpoint`, {
                service,
                subnets: { subnetGroupName: 'Private' },
                securityGroups: [securityGroup],
            });
        }
    }
}
