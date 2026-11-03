/**
 * Names of the secrets and parameters shared between CDK, `setup-pki.sh` and the client simulator.
 *
 * Keys, certificates and the CRL are created by `setup-pki.sh` outside CloudFormation so that
 * private keys never appear in a template; the stacks only reference them by name.
 */
export class VpnNames {
  readonly prefix: string;

  /** Builds the names for one project / environment. */
  constructor(project: string, environment: string) {
    this.prefix = `/${project}/${environment}/vpn`;
  }

  // ---- created by setup-pki.sh ----

  /** ACM ARN of the imported server certificate (also used as the client CA for Client VPN). */
  get acmServerCertArnParam(): string {
    return `${this.prefix}/acm/server-cert-arn`;
  }

  /** JSON `{ca, cert, key, crl}` read by the OpenVPN server at boot. */
  get openVpnServerSecret(): string {
    return `${this.prefix}/openvpn/server`;
  }

  /** JSON `{privateKey}` read by the WireGuard server at boot. */
  get wireGuardServerSecret(): string {
    return `${this.prefix}/wireguard/server`;
  }

  /** WireGuard server public key (not secret). */
  get wireGuardServerPublicKeyParam(): string {
    return `${this.prefix}/wireguard/server-public-key`;
  }

  /** JSON array of `{name, publicKey, address}` registered as WireGuard peers. */
  get wireGuardPeersParam(): string {
    return `${this.prefix}/wireguard/peers`;
  }

  /** Prefix of the per-client bundles `{ca, cert, key, wgPrivateKey, wgAddress}`. */
  get clientSecretPrefix(): string {
    return `${this.prefix}/clients/`;
  }

  // ---- written by the stacks ----

  /** Private IP of the target web server. */
  get targetPrivateIpParam(): string {
    return `${this.prefix}/target/private-ip`;
  }

  /** CIDR of the target VPC (WireGuard AllowedIPs on the client). */
  get targetVpcCidrParam(): string {
    return `${this.prefix}/target/vpc-cidr`;
  }

  /** ID of the Client VPN endpoint. */
  get clientVpnEndpointIdParam(): string {
    return `${this.prefix}/client-vpn/endpoint-id`;
  }

  /** Elastic IP of the OpenVPN server. */
  get openVpnPublicIpParam(): string {
    return `${this.prefix}/openvpn/public-ip`;
  }

  /** Elastic IP of the WireGuard server. */
  get wireGuardPublicIpParam(): string {
    return `${this.prefix}/wireguard/public-ip`;
  }
}
