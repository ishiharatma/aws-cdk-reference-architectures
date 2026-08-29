import { EnvironmentConfig } from '@common/parameters/environments';
import { VpcConfig } from '@common/types/vpc';

/**
 * Transit Gateway multi-VPC parameters.
 *
 * Creates three VPCs (A / B / C) in a single account and region, joins them with a
 * Transit Gateway, and drops one test instance into each VPC for connectivity checks.
 */
export interface TransitGatewayParams extends EnvironmentConfig {
    /** VPC A configuration (workshop default CIDR 10.0.0.0/16). */
    readonly vpcAConfig: VpcConfig;
    /** VPC B configuration (workshop default CIDR 10.1.0.0/16). */
    readonly vpcBConfig: VpcConfig;
    /** VPC C configuration (workshop default CIDR 10.2.0.0/16). */
    readonly vpcCConfig: VpcConfig;
    /**
     * Private Autonomous System Number for the Amazon side of the Transit Gateway.
     * @default 64512
     */
    readonly amazonSideAsn?: number;
    /**
     * Supernet CIDR that encompasses every attached VPC. Used only for the security-group
     * rules that permit intra-mesh ICMP / SSH between the test instances; the Transit
     * Gateway routes themselves target each specific peer VPC CIDR.
     * @default '10.0.0.0/8'
     */
    readonly connectedNetworkCidr?: string;
}

/**
 * Environment parameters type.
 */
export type EnvParams = TransitGatewayParams;
