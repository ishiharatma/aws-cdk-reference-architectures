import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
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
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

const CODE_SERVER_PORT = 8080;

/**
 * code-server on a single EC2 instance, published through CloudFront.
 *
 * The instance sits in a public subnet only so CloudFront can reach its public DNS name; its
 * security group admits nothing except the CloudFront origin-facing managed prefix list, so the
 * instance is not reachable directly. The code-server password is generated into Secrets Manager
 * and read by the instance at boot with its instance role. Shell access is SSM Session Manager.
 */
export class CodeServerEc2Stack extends cdk.Stack {
  /**
   *
   */
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const ec2Params = params.ec2 ?? {};
    const codeServerVersion = ec2Params.codeServerVersion ?? '4.141.0';

    // Public subnets only: no NAT Gateway, which is the dominant fixed cost of a private-subnet layout.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const password = new secretsmanager.Secret(this, 'CodeServerPassword', {
      secretName: `${project}-${environment}-code-server-ec2-password`,
      description: 'code-server login password (EC2 variant)',
      generateSecretString: { passwordLength: 24, excludePunctuation: true },
      removalPolicy,
    });

    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
      vpc,
      description: 'code-server instance: inbound only from CloudFront origin-facing IPs',
      allowAllOutbound: true,
    });
    const cloudFrontPrefixList = ec2.PrefixList.fromLookup(this, 'CloudFrontPrefixList', {
      prefixListName: 'com.amazonaws.global.cloudfront.origin-facing',
    });
    securityGroup.addIngressRule(
      ec2.Peer.prefixList(cloudFrontPrefixList.prefixListId),
      ec2.Port.tcp(CODE_SERVER_PORT),
      'code-server from CloudFront',
    );

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    password.grantRead(role);

    const bedrock = resolveBedrock(params.bedrock);
    if (bedrock.enabled) role.addToPolicy(claudeInvokePolicy(this, bedrock));

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'dnf install -y git tar gzip',
      `curl -fsSL https://github.com/coder/code-server/releases/download/v${codeServerVersion}/code-server-${codeServerVersion}-linux-arm64.tar.gz -o /tmp/code-server.tgz`,
      'mkdir -p /opt/code-server && tar -xzf /tmp/code-server.tgz -C /opt/code-server --strip-components=1',
      'ln -sf /opt/code-server/bin/code-server /usr/local/bin/code-server',
      'install -d -o ec2-user -g ec2-user /home/ec2-user/project',
      // The password never touches the CloudFormation template or the instance's user-data: it is
      // fetched at boot and kept in a root-only environment file for the systemd unit.
      `PASSWORD=$(aws secretsmanager get-secret-value --region ${this.region} --secret-id ${password.secretArn} --query SecretString --output text)`,
      '(umask 077; printf "PASSWORD=%s\\n" "$PASSWORD" > /etc/code-server.env)',
      'cat > /etc/systemd/system/code-server.service <<\'UNIT\'',
      '[Unit]',
      'Description=code-server',
      'After=network-online.target',
      '[Service]',
      'User=ec2-user',
      'EnvironmentFile=/etc/code-server.env',
      'Environment=HOME=/home/ec2-user',
      `ExecStart=/usr/local/bin/code-server --bind-addr 0.0.0.0:${CODE_SERVER_PORT} --auth password --disable-telemetry --disable-update-check /home/ec2-user/project`,
      'Restart=always',
      '[Install]',
      'WantedBy=multi-user.target',
      'UNIT',
      'systemctl daemon-reload && systemctl enable --now code-server',
    );
    if (bedrock.enabled) {
      // Claude Code CLI + VS Code extension (Open VSX), both reading ~/.claude/settings.json.
      userData.addCommands(
        'dnf install -y nodejs22 nodejs22-npm',
        'npm install -g @anthropic-ai/claude-code',
        "sudo -u ec2-user HOME=/home/ec2-user /usr/local/bin/code-server --install-extension Anthropic.claude-code",
        'install -d -o ec2-user -g ec2-user /home/ec2-user/.claude',
        `cat > /home/ec2-user/.claude/settings.json <<'JSON'\n${claudeSettings(bedrock, this.region)}\nJSON`,
        'chown ec2-user:ec2-user /home/ec2-user/.claude/settings.json',
      );
    }

    const instance = new ec2.Instance(this, 'Instance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: true,
      instanceType: new ec2.InstanceType(ec2Params.instanceType ?? 't4g.medium'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      securityGroup,
      role,
      requireImdsv2: true,
      userData,
      userDataCausesReplacement: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(ec2Params.volumeSizeGiB ?? 30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${project}-${environment} code-server (EC2)`,
      defaultBehavior: {
        origin: new origins.HttpOrigin(instance.instancePublicDnsName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          httpPort: CODE_SERVER_PORT,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // code-server is fully dynamic and uses WebSockets: never cache, forward everything.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    new cdk.CfnOutput(this, 'CodeServerUrl', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'PasswordSecretName', { value: password.secretName });
    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
  }
}
