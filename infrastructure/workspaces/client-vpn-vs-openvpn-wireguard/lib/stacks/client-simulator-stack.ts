import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { VpnNames } from 'lib/vpn-names';
import { encryptedRootVolume, readSource, ubuntuImage } from 'lib/constructs/ubuntu';

/** Properties for {@link ClientSimulatorStack}. */
export interface ClientSimulatorStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly envParams: EnvParams;
}

/**
 * Verification harness: an instance in an unrelated VPC (no peering, no Transit Gateway) that
 * plays the remote user's laptop. It reaches the three VPN endpoints over the internet exactly as
 * a home PC would, and `test-vpn.sh` drives it through SSM Run Command.
 *
 * Not part of the pattern itself; disable it with `clientSimulator.enabled = false`.
 */
export class ClientSimulatorStack extends cdk.Stack {
  /** Creates the resources described above. */
  constructor(scope: Construct, id: string, props: ClientSimulatorStackProps) {
    super(scope, id, props);
    const { clientSimulator } = props.envParams;
    const names = new VpnNames(props.project, props.environment);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(clientSimulator.vpcCidr),
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const securityGroup = new ec2.SecurityGroup(this, 'Sg', {
      vpc,
      description: 'VPN client simulator (outbound only)',
      allowAllOutbound: true,
    });

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'VPN client simulator: Session Manager and client bundles',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    const prefix = names.prefix.replace(/^\//, '');
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          this.formatArn({
            service: 'secretsmanager',
            resource: 'secret',
            resourceName: `${names.clientSecretPrefix}*`,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `${prefix}/*` })],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:ExportClientVpnClientConfiguration'],
        resources: [this.formatArn({ service: 'ec2', resource: 'client-vpn-endpoint', resourceName: '*' })],
      }),
    );

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'export DEBIAN_FRONTEND=noninteractive',
      'retry() { for i in $(seq 1 10); do "$@" && return 0; sleep 15; done; return 1; }',
      'retry apt-get -o DPkg::Lock::Timeout=600 update',
      'retry apt-get -o DPkg::Lock::Timeout=600 install -y openvpn wireguard-tools jq bc',
      'retry snap install aws-cli --classic',
      // Ubuntu starts no OpenVPN client by default; the test script launches it on demand.
      `cat > /etc/vpn-test.env <<'EOF'\nREGION=${this.region}\nPREFIX=${names.prefix}\nEOF`,
      `cat > /usr/local/bin/vpn-test <<'SHEOF'\n${readSource('client-simulator/vpn-test.sh')}SHEOF`,
      'chmod 755 /usr/local/bin/vpn-test',
    );

    const instance = new ec2.Instance(this, 'Instance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(clientSimulator.instanceType),
      machineImage: ubuntuImage(),
      securityGroup,
      role,
      requireImdsv2: true,
      blockDevices: [encryptedRootVolume()],
      userData,
      userDataCausesReplacement: true,
      associatePublicIpAddress: true,
    });

    new cdk.CfnOutput(this, 'ClientSimulatorInstanceId', { value: instance.instanceId });
  }
}
