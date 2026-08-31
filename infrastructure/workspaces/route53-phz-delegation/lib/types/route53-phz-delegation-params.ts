import { EnvironmentConfig } from '@common/parameters/environments';
import { VpcConfig } from '@common/types/vpc';

/**
 * Route 53 private hosted zone delegation parameters.
 *
 * Four VPCs joined by one Transit Gateway:
 * - HubVpc owns the parent private hosted zone and delegates two subdomains to DevVpc/StgVpc
 *   using the June 2025 Route 53 Resolver DNS delegation feature (`INBOUND_DELEGATION`
 *   endpoints + `DELEGATE` resolver rules).
 * - DevVpc / StgVpc each own one child private hosted zone.
 * - OnPremVpc stands in for on-premises infrastructure with a BIND9 forwarder.
 */
export interface Route53PhzDelegationParams extends EnvironmentConfig {
    readonly hubVpcConfig: VpcConfig;
    readonly devVpcConfig: VpcConfig;
    readonly stgVpcConfig: VpcConfig;
    readonly onPremVpcConfig: VpcConfig;
    /**
     * Parent private hosted zone name, owned by HubVpc.
     * @default 'system.example.com'
     */
    readonly parentZoneName?: string;
    /**
     * Child private hosted zone name delegated to DevVpc.
     * @default 'dev.system.example.com'
     */
    readonly devZoneName?: string;
    /**
     * Child private hosted zone name delegated to StgVpc.
     * @default 'stg.system.example.com'
     */
    readonly stgZoneName?: string;
    /**
     * Private Autonomous System Number for the Amazon side of the Transit Gateway.
     * @default 64512
     */
    readonly amazonSideAsn?: number;
}

/**
 * Environment parameters type.
 */
export type EnvParams = Route53PhzDelegationParams;
