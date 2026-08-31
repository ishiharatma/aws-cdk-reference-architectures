import { EnvironmentConfig } from '@common/parameters/environments';
import { VpcConfig } from '@common/types/vpc';

/**
 * Route 53 Resolver inbound endpoint category.
 * - `DEFAULT`: a regular inbound endpoint (`Direction: INBOUND`) for on-premises resolvers
 *   to forward queries into the VPC's private hosted zone.
 * - `DELEGATION`: the June 2025 delegation inbound endpoint (`Direction: INBOUND_DELEGATION`)
 *   that lets an on-premises DNS server delegate a subdomain to Route 53 via NS records,
 *   instead of a conditional forwarding rule.
 */
export type InboundEndpointType = 'DEFAULT' | 'DELEGATION';

/**
 * Route 53 Resolver in/outbound endpoints parameters.
 *
 * Provisions a verification VPC (owns the `system.example.com` private hosted zone and
 * both Resolver endpoints) peered with an on-premises-role VPC running a BIND9 DNS server.
 */
export interface Route53ResolverEndpointsParams extends EnvironmentConfig {
    /** Verification VPC: hosts the private hosted zone, both Resolver endpoints, and the test instance. */
    readonly verifyVpcConfig: VpcConfig;
    /** On-premises-role VPC: hosts the BIND9 DNS server, reached over VPC peering. */
    readonly onPremVpcConfig: VpcConfig;
    /**
     * Private hosted zone name associated with the verification VPC.
     * @default 'system.example.com'
     */
    readonly privateHostedZoneName?: string;
    /**
     * Domain name that the on-premises BIND9 server is authoritative for. A Resolver
     * FORWARD rule sends queries for this domain out through the outbound endpoint.
     * @default 'onprem.example.com'
     */
    readonly onPremDomainName?: string;
    /**
     * Inbound endpoint category, switchable without code changes.
     * @default 'DEFAULT'
     */
    readonly inboundEndpointType?: InboundEndpointType;
}

/**
 * Environment parameters type.
 */
export type EnvParams = Route53ResolverEndpointsParams;
