import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/** VPC that hosts the private resources the remote users need to reach. */
export interface TargetNetworkParams {
  readonly vpcCidr: string;
  /** Two AZs so that the Client VPN endpoint can be associated with two subnets. */
  readonly maxAzs: number;
  /** Instance type of the private web server used as the connection target. */
  readonly targetInstanceType: string;
}

/** AWS Client VPN endpoint (managed, OpenVPN-compatible). */
export interface ClientVpnParams {
  /** Address pool for connected clients. Must be between /12 and /22 and cannot be changed later. */
  readonly clientCidr: string;
  /** Number of AZ subnet associations. Each association is billed per hour. */
  readonly subnetAssociations: number;
  /** Only routes to the VPC go through the tunnel; other traffic uses the client's own internet. */
  readonly splitTunnel: boolean;
  readonly transportProtocol: 'udp' | 'tcp';
  readonly port: 443 | 1194;
  /** Maximum session length in hours (8, 10, 12 or 24). */
  readonly sessionTimeoutHours: 8 | 10 | 12 | 24;
  /** Certificate common names rejected by the client connect handler Lambda. */
  readonly deniedCommonNames: string[];
  readonly loginBanner: string;
}

/** Self-hosted VPN server on EC2 (shared by OpenVPN and WireGuard). */
export interface SelfHostedVpnParams {
  readonly instanceType: string;
  /** UDP port the server listens on. */
  readonly port: number;
  /** Tunnel address pool handed out to clients (the server takes the first address). */
  readonly tunnelCidr: string;
  /**
   * Tunnel MTU (WireGuard only; OpenVPN clamps TCP MSS itself). Leave at 1420: EC2 ENIs use a
   * 9001-byte MTU, so wg-quick's automatic value (8921) overshoots the 1500-byte internet path.
   * @default 1420
   */
  readonly mtu?: number;
}

/** EC2 instance in a separate VPC that plays the remote user's laptop during verification. */
export interface ClientSimulatorParams {
  readonly enabled: boolean;
  readonly vpcCidr: string;
  readonly instanceType: string;
}

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  readonly targetNetwork: TargetNetworkParams;
  readonly clientVpn: ClientVpnParams;
  readonly openVpn: SelfHostedVpnParams;
  readonly wireGuard: SelfHostedVpnParams;
  readonly clientSimulator: ClientSimulatorParams;
  /**
   * Source ranges allowed to reach the self-hosted VPN ports.
   * Remote users connect from unpredictable home / mobile networks, so this is usually 0.0.0.0/0;
   * the VPN protocol itself (certificates / keys) is the access control.
   */
  readonly vpnIngressCidrs: string[];
  readonly logRetentionDays: number;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
