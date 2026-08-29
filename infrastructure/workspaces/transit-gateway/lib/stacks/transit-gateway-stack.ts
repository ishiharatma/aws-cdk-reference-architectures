import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { VpcConstruct } from '@common/constructs/vpc/vpc';
import { TransitGatewayConstruct } from '@common/constructs/vpc/transit-gateway';
import { TestInstance } from '@common/constructs/ec2/ec2-testinstance';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'lib/types/transit-gateway-params';

/**
 * Properties for {@link TransitGatewayStack}.
 */
export interface TransitGatewayStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
    /**
     * Operator IPv4 addresses (bare IP or CIDR) allowed to reach the test instances over SSH.
     * Resolved in `bin/transit-gateway.ts` from `ALLOWED_IPS` or this machine's own global IP.
     */
    readonly allowedIps: string[];
    /** IPv6 counterpart to {@link allowedIps}; omit or pass an empty array if unavailable. */
    readonly allowedIpv6s?: string[];
}

/**
 * Internal pairing of a VPC's logical name with the construct that created it.
 */
interface VpcDefinition {
    readonly name: string;
    readonly construct: VpcConstruct;
}

/**
 * Transit Gateway Stack
 *
 * Single-account, single-region reproduction of the AWS multi-VPC Transit Gateway lab:
 *
 * - Creates VPC A / B / C from the environment parameters
 * - Joins them with one Transit Gateway (full mesh via a single TGW route table)
 * - Places one SSM-managed test instance in each VPC's public subnet
 * - Security groups permit intra-mesh ICMP / SSH (via `connectedNetworkCidr`) plus SSH
 *   from the operator's own global IP only
 */
export class TransitGatewayStack extends cdk.Stack {
    public readonly vpcs: Record<string, VpcConstruct> = {};
    public readonly transitGateway: TransitGatewayConstruct;

    /**
     * Provisions VPC A/B/C, the Transit Gateway that meshes them, and one test instance per VPC.
     * @param scope parent construct
     * @param id stack id
     * @param props stack configuration
     */
    constructor(scope: Construct, id: string, props: TransitGatewayStackProps) {
        super(scope, id, props);

        const prefix = [props.project, props.environment].join('/');
        const connectedNetworkCidr = props.params.connectedNetworkCidr ?? '10.0.0.0/8';

        // 1. Create the three VPCs.
        const definitions: VpcDefinition[] = (
            [
                { name: 'VpcA', config: props.params.vpcAConfig },
                { name: 'VpcB', config: props.params.vpcBConfig },
                { name: 'VpcC', config: props.params.vpcCConfig },
            ] as const
        ).map(({ name, config }) => {
            const construct = new VpcConstruct(this, name, {
                project: props.project,
                environment: props.environment,
                config,
                prefix,
            });
            this.vpcs[name] = construct;
            return { name, construct };
        });

        // 2. Attach every VPC to a single Transit Gateway.
        //    - TGW ENIs live in the dedicated "Tgw" isolated subnets
        //    - routes towards the TGW are added to the public + isolated route tables
        this.transitGateway = new TransitGatewayConstruct(this, 'TransitGateway', {
            project: props.project,
            environment: props.environment,
            amazonSideAsn: props.params.amazonSideAsn,
            attachments: definitions.map(({ name, construct }) => ({
                name,
                vpc: construct.vpc,
                attachmentSubnets: construct.vpc.selectSubnets({ subnetGroupName: 'Tgw' }).subnets,
                routableSubnets: [...construct.vpc.publicSubnets, ...construct.vpc.isolatedSubnets],
            })),
        });

        // 3. One test instance per VPC for connectivity verification.
        for (const { name, construct } of definitions) {
            const sg = new ec2.SecurityGroup(this, `${name}TestInstanceSg`, {
                vpc: construct.vpc,
                description: `Cross-VPC connectivity test security group for ${name}`,
                allowAllOutbound: true,
            });

            // Reachable from the other VPCs joined by the Transit Gateway.
            sg.addIngressRule(
                ec2.Peer.ipv4(connectedNetworkCidr),
                ec2.Port.allIcmp(),
                'Allow ICMP from Transit Gateway connected networks',
            );
            sg.addIngressRule(
                ec2.Peer.ipv4(connectedNetworkCidr),
                ec2.Port.tcp(22),
                'Allow SSH from Transit Gateway connected networks',
            );

            // Reachable over SSH from the operator's own global IP only.
            for (const ip of props.allowedIps) {
                const cidr = ip.includes('/') ? ip : `${ip}/32`;
                sg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(22), `Allow SSH from operator IP ${cidr}`);
            }
            for (const ip of props.allowedIpv6s ?? []) {
                const cidr = ip.includes('/') ? ip : `${ip}/128`;
                sg.addIngressRule(ec2.Peer.ipv6(cidr), ec2.Port.tcp(22), `Allow SSH from operator IPv6 ${cidr}`);
            }

            const testInstance = new TestInstance(this, `${name}TestInstance`, {
                project: props.project,
                environment: props.environment,
                vpc: construct.vpc,
                targetSubnetType: ec2.SubnetType.PUBLIC,
                additionalSecurityGroups: [sg],
            });

            new cdk.CfnOutput(this, `${name}TestInstanceId`, {
                value: testInstance.instance.instanceId,
                description: `Test EC2 instance ID in ${name}`,
            });
            new cdk.CfnOutput(this, `${name}Cidr`, {
                value: construct.vpc.vpcCidrBlock,
                description: `${name} CIDR block`,
            });
        }

        // Apply common tags.
        if (props.params.tags) {
            Object.entries(props.params.tags).forEach(([key, value]) => {
                cdk.Tags.of(this).add(key, value);
            });
        }
    }
}
