import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { VpnNames } from 'lib/vpn-names';
import { cidrToNetmask, hostAddress } from 'lib/cidr';
import { SelfHostedVpnServer } from 'lib/constructs/self-hosted-vpn-server';
import { readSource, renderTemplate } from 'lib/constructs/ubuntu';
import { addTargetIngress } from 'lib/stacks/client-vpn-stack';

/** Properties for {@link OpenVpnStack} and {@link WireGuardStack}. */
export interface SelfHostedVpnStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly envParams: EnvParams;
  readonly vpc: ec2.IVpc;
  readonly targetSecurityGroup: ec2.ISecurityGroup;
}

/**
 * Method B: OpenVPN community edition on EC2.
 *
 * Uses the same CA as Client VPN (both speak the OpenVPN protocol), so a client certificate works
 * against either server. Revocation is a CRL file read by the server; logs are OpenVPN's own.
 */
export class OpenVpnStack extends cdk.Stack {
  readonly server: SelfHostedVpnServer;

  /** Creates the resources described above. */
  constructor(scope: Construct, id: string, props: SelfHostedVpnStackProps) {
    super(scope, id, props);
    const { openVpn, targetNetwork } = props.envParams;
    const names = new VpnNames(props.project, props.environment);
    const tunnel = cidrToNetmask(openVpn.tunnelCidr);
    const vpcNet = cidrToNetmask(targetNetwork.vpcCidr);

    this.server = new SelfHostedVpnServer(this, 'Server', {
      vpc: props.vpc,
      label: 'OpenVPN',
      instanceType: openVpn.instanceType,
      port: openVpn.port,
      ingressCidrs: props.envParams.vpnIngressCidrs,
      logRetentionDays: props.envParams.logRetentionDays,
      secretNames: [names.openVpnServerSecret],
      userData: (logGroupName) =>
        renderTemplate(readSource('openvpn/bootstrap.sh'), {
          REGION: this.region,
          SECRET_ID: names.openVpnServerSecret,
          PORT: String(openVpn.port),
          TUNNEL_NETWORK: tunnel.network,
          TUNNEL_NETMASK: tunnel.netmask,
          TUNNEL_CIDR: openVpn.tunnelCidr,
          VPC_NETWORK: vpcNet.network,
          VPC_NETMASK: vpcNet.netmask,
          LOG_GROUP: logGroupName,
        }),
    });

    addTargetIngress(this, 'TargetFromOpenVpn', props.targetSecurityGroup, this.server.securityGroup, 'OpenVPN');

    new ssm.StringParameter(this, 'PublicIpParam', {
      parameterName: names.openVpnPublicIpParam,
      stringValue: this.server.elasticIp.attrPublicIp,
    });
    new cdk.CfnOutput(this, 'OpenVpnPublicIp', { value: this.server.elasticIp.attrPublicIp });
    new cdk.CfnOutput(this, 'OpenVpnInstanceId', { value: this.server.instance.instanceId });
  }
}

/**
 * Method C: WireGuard on EC2.
 *
 * No certificates and no user identity: each peer is a public key bound to one tunnel address.
 * The server key is in Secrets Manager and the peer list in SSM Parameter Store, both created by
 * `setup-pki.sh`. WireGuard writes no connection log, so a timer records per-peer handshake state.
 */
export class WireGuardStack extends cdk.Stack {
  readonly server: SelfHostedVpnServer;

  /** Creates the resources described above. */
  constructor(scope: Construct, id: string, props: SelfHostedVpnStackProps) {
    super(scope, id, props);
    const { wireGuard } = props.envParams;
    const names = new VpnNames(props.project, props.environment);
    const tunnel = cidrToNetmask(wireGuard.tunnelCidr);

    this.server = new SelfHostedVpnServer(this, 'Server', {
      vpc: props.vpc,
      label: 'WireGuard',
      instanceType: wireGuard.instanceType,
      port: wireGuard.port,
      ingressCidrs: props.envParams.vpnIngressCidrs,
      logRetentionDays: props.envParams.logRetentionDays,
      secretNames: [names.wireGuardServerSecret],
      parameterNames: [names.wireGuardPeersParam],
      userData: (logGroupName) =>
        renderTemplate(readSource('wireguard/bootstrap.sh'), {
          REGION: this.region,
          SECRET_ID: names.wireGuardServerSecret,
          PEERS_PARAM: names.wireGuardPeersParam,
          PORT: String(wireGuard.port),
          SERVER_ADDRESS: `${hostAddress(wireGuard.tunnelCidr, 1)}/${tunnel.prefix}`,
          TUNNEL_CIDR: wireGuard.tunnelCidr,
          MTU: String(wireGuard.mtu ?? 1420),
          LOG_GROUP: logGroupName,
        }),
    });

    addTargetIngress(this, 'TargetFromWireGuard', props.targetSecurityGroup, this.server.securityGroup, 'WireGuard');

    new ssm.StringParameter(this, 'PublicIpParam', {
      parameterName: names.wireGuardPublicIpParam,
      stringValue: this.server.elasticIp.attrPublicIp,
    });
    new cdk.CfnOutput(this, 'WireGuardPublicIp', { value: this.server.elasticIp.attrPublicIp });
    new cdk.CfnOutput(this, 'WireGuardInstanceId', { value: this.server.instance.instanceId });
  }
}
