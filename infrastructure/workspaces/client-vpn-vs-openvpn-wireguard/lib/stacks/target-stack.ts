import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { VpnNames } from 'lib/vpn-names';
import { encryptedRootVolume, readSource, ubuntuImage } from 'lib/constructs/ubuntu';

/** Properties for {@link TargetStack}. */
export interface TargetStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly envParams: EnvParams;
}

/**
 * The network the remote users need to reach.
 *
 * - Public subnets: the self-hosted VPN servers (OpenVPN / WireGuard) need a public IP.
 * - Isolated subnets: the target web server and the Client VPN associations. No NAT gateway:
 *   the target is reachable only through one of the three VPNs.
 *
 * Each VPN stack opens the target security group to its own security group, so the target only
 * accepts traffic that came through a VPN.
 */
export class TargetStack extends cdk.Stack {
  readonly vpc: ec2.IVpc;
  readonly targetSecurityGroup: ec2.ISecurityGroup;

  /** Creates the resources described above. */
  constructor(scope: Construct, id: string, props: TargetStackProps) {
    super(scope, id, props);
    const { targetNetwork, logRetentionDays } = props.envParams;
    const names = new VpnNames(props.project, props.environment);

    const flowLogGroup = new logs.LogGroup(this, 'FlowLogGroup', {
      retention: logRetentionDays,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(targetNetwork.vpcCidr),
      maxAzs: targetNetwork.maxAzs,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      flowLogs: {
        All: {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
          trafficType: ec2.FlowLogTrafficType.ALL,
        },
      },
    });

    this.targetSecurityGroup = new ec2.SecurityGroup(this, 'TargetSg', {
      vpc: this.vpc,
      description: 'Private web server reachable only through a VPN',
      allowAllOutbound: false,
    });

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'install -d /opt/target',
      `cat > /opt/target/app.py <<'PYEOF'\n${readSource('target/app.py')}PYEOF`,
      `cat > /etc/systemd/system/target-web.service <<'EOF'
[Unit]
Description=VPN comparison target web server
After=network-online.target

[Service]
ExecStart=/usr/bin/python3 /opt/target/app.py
Restart=always
DynamicUser=yes
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF`,
      'systemctl daemon-reload',
      'systemctl enable --now target-web.service',
    );

    const target = new ec2.Instance(this, 'TargetServer', {
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED, availabilityZones: [this.vpc.availabilityZones[0]] },
      instanceType: new ec2.InstanceType(targetNetwork.targetInstanceType),
      machineImage: ubuntuImage(),
      securityGroup: this.targetSecurityGroup,
      requireImdsv2: true,
      blockDevices: [encryptedRootVolume()],
      userData,
      userDataCausesReplacement: true,
    });

    new ssm.StringParameter(this, 'TargetPrivateIpParam', {
      parameterName: names.targetPrivateIpParam,
      stringValue: target.instancePrivateIp,
    });

    new ssm.StringParameter(this, 'TargetVpcCidrParam', {
      parameterName: names.targetVpcCidrParam,
      stringValue: this.vpc.vpcCidrBlock,
    });

    new cdk.CfnOutput(this, 'TargetPrivateIp', { value: target.instancePrivateIp });
  }
}
