import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { TargetStack } from 'lib/stacks/target-stack';
import { ClientVpnStack } from 'lib/stacks/client-vpn-stack';
import { OpenVpnStack, WireGuardStack } from 'lib/stacks/self-hosted-vpn-stacks';
import { ClientSimulatorStack } from 'lib/stacks/client-simulator-stack';

/** Properties for {@link ClientVpnVsOpenvpnWireguardStage}. */
export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

/**
 * One target network and three remote-access VPNs in front of it, one stack each so a method can
 * be deployed or destroyed on its own. The client simulator stack is the verification harness.
 */
export class ClientVpnVsOpenvpnWireguardStage extends cdk.Stage {
  readonly target: TargetStack;
  readonly clientVpn: ClientVpnStack;
  readonly openVpn: OpenVpnStack;
  readonly wireGuard: WireGuardStack;
  readonly clientSimulator?: ClientSimulatorStack;

  /** Creates the resources described above. */
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);
    const prefix = `${props.project}-${props.environment}-vpn`;
    const common = {
      project: props.project,
      environment: props.environment,
      envParams: props.params,
      env: props.env,
      terminationProtection: props.terminationProtection,
    };

    this.target = new TargetStack(this, 'Target', {
      ...common,
      stackName: `${prefix}-target`,
      description: 'Target VPC and private web server reachable only through a VPN',
    });
    const network = { vpc: this.target.vpc, targetSecurityGroup: this.target.targetSecurityGroup };

    this.clientVpn = new ClientVpnStack(this, 'ClientVpn', {
      ...common,
      ...network,
      stackName: `${prefix}-client-vpn`,
      description: 'Method A: AWS Client VPN (managed, mutual TLS, connect handler)',
    });
    this.openVpn = new OpenVpnStack(this, 'OpenVpn', {
      ...common,
      ...network,
      stackName: `${prefix}-openvpn`,
      description: 'Method B: OpenVPN community server on EC2',
    });
    this.wireGuard = new WireGuardStack(this, 'WireGuard', {
      ...common,
      ...network,
      stackName: `${prefix}-wireguard`,
      description: 'Method C: WireGuard server on EC2',
    });

    if (props.params.clientSimulator.enabled) {
      this.clientSimulator = new ClientSimulatorStack(this, 'ClientSimulator', {
        ...common,
        stackName: `${prefix}-client-sim`,
        description: 'Verification harness: remote client in an unrelated VPC',
      });
    }
  }
}
