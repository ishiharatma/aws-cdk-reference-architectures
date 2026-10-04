import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  /** CIDR of spoke VPC A (hosts the test client). */
  readonly spokeACidr: string;
  /** CIDR of spoke VPC B (hosts the test server). */
  readonly spokeBCidr: string;
  /** CIDR of the inspection VPC (Network Firewall, NAT gateway, Transit Gateway attachment). */
  readonly inspectionCidr: string;
  /** Supernet that contains every spoke; used as the firewall's HOME_NET. */
  readonly homeNet: string;
  /** Domains the spokes may reach over HTTP/HTTPS. A leading dot matches subdomains. Everything else is dropped. */
  readonly allowedDomains: string[];
  /**
   * TCP ports allowed between the spokes. The domain allow list applies to every HTTP/TLS flow, east-west included,
   * so east-west services need an explicit pass rule that is evaluated before it.
   */
  readonly eastWestAllowedTcpPorts: number[];
  /** Block ICMP between the spokes (east-west) while other east-west traffic stays allowed. */
  readonly blockEastWestIcmp: boolean;
  /** Retention of the firewall alert and flow logs in days. */
  readonly logRetentionDays: 1 | 3 | 5 | 7 | 14 | 30;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
