import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { claudeInvokePolicy, claudeSettings, resolveBedrock } from 'lib/shared/claude-bedrock';

/**
 *
 */
interface StackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly params: EnvParams;
}

const CODE_SERVER_PORT = 8080;

/**
 * What one user's code-server instance is launched from. The control plane calls RunInstances per
 * session with this launch template, so no instance exists until someone starts a session.
 *
 * Instances sit in private subnets with no inbound rule at all, and code-server binds to loopback.
 * The only way in is a Session Manager port forward, opened by the control plane for the owner.
 * The NAT Gateway carries the install, Open VSX and Session Manager traffic.
 */
export class Ec2ComputeStack extends cdk.Stack {
  public readonly launchTemplate: ec2.ILaunchTemplate;
  public readonly instanceRole: iam.IRole;
  public readonly subnetIds: string[];

  /**
   *
   */
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const { project, environment, params } = props;
    const namePrefix = `${project}-${environment}-code-server-sessions`;
    const ec2Params = params.ec2 ?? {};
    const codeServerVersion = params.codeServerVersion ?? '4.141.0';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });
    this.subnetIds = vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds;

    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
      vpc,
      description: 'code-server instances: no inbound; Session Manager is outbound from the agent',
      allowAllOutbound: true,
    });

    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Assumed by per-session code-server instances; reachable from the user terminal',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });

    const bedrock = resolveBedrock(params.bedrock);
    if (bedrock.enabled) instanceRole.addToPolicy(claudeInvokePolicy(this, bedrock));
    this.instanceRole = instanceRole;

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'dnf install -y git tar gzip',
      `curl -fsSL https://github.com/coder/code-server/releases/download/v${codeServerVersion}/code-server-${codeServerVersion}-linux-arm64.tar.gz -o /tmp/code-server.tgz`,
      'mkdir -p /opt/code-server && tar -xzf /tmp/code-server.tgz -C /opt/code-server --strip-components=1',
      'ln -sf /opt/code-server/bin/code-server /usr/local/bin/code-server',
      'install -d -o ec2-user -g ec2-user /home/ec2-user/project',
    );
    if (bedrock.enabled) {
      // Claude Code CLI + VS Code extension (Open VSX), both reading ~/.claude/settings.json.
      userData.addCommands(
        'dnf install -y nodejs22 nodejs22-npm',
        'npm install -g @anthropic-ai/claude-code',
        'sudo -u ec2-user HOME=/home/ec2-user /usr/local/bin/code-server --install-extension Anthropic.claude-code',
        'install -d -o ec2-user -g ec2-user /home/ec2-user/.claude',
        `cat > /home/ec2-user/.claude/settings.json <<'JSON'\n${claudeSettings(bedrock, this.region)}\nJSON`,
        'chown ec2-user:ec2-user /home/ec2-user/.claude/settings.json',
      );
    }
    // Started last so a reachable code-server means the instance is fully set up. --auth none is
    // safe here because loopback is reachable only through the owner's port forward.
    userData.addCommands(
      "cat > /etc/systemd/system/code-server.service <<'UNIT'",
      '[Unit]',
      'Description=code-server',
      'After=network-online.target',
      '[Service]',
      'User=ec2-user',
      'Environment=HOME=/home/ec2-user',
      `ExecStart=/usr/local/bin/code-server --bind-addr 127.0.0.1:${CODE_SERVER_PORT} --auth none --disable-telemetry --disable-update-check /home/ec2-user/project`,
      'Restart=always',
      '[Install]',
      'WantedBy=multi-user.target',
      'UNIT',
      'systemctl daemon-reload && systemctl enable --now code-server',
    );

    this.launchTemplate = new ec2.LaunchTemplate(this, 'InstanceTemplate', {
      launchTemplateName: `${namePrefix}-instance`,
      instanceType: new ec2.InstanceType(ec2Params.instanceType ?? 't4g.medium'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      securityGroup,
      role: this.instanceRole,
      requireImdsv2: true,
      userData,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(ec2Params.volumeSizeGiB ?? 30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    new cdk.CfnOutput(this, 'LaunchTemplateId', { value: this.launchTemplate.launchTemplateId as string });
  }
}
