import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { encryptedRootVolume, ubuntuImage } from 'lib/constructs/ubuntu';

/** Properties for {@link SelfHostedVpnServer}. */
export interface SelfHostedVpnServerProps {
  readonly vpc: ec2.IVpc;
  /** Human-readable name used in descriptions ("OpenVPN", "WireGuard"). */
  readonly label: string;
  readonly instanceType: string;
  readonly port: number;
  readonly ingressCidrs: string[];
  readonly logRetentionDays: number;
  /** Builds the bootstrap script once the log group name is known. */
  readonly userData: (logGroupName: string) => string;
  /** Secrets Manager secret names the server reads at boot. */
  readonly secretNames: string[];
  /** SSM parameter names the server reads at boot. */
  readonly parameterNames?: string[];
}

/**
 * One self-hosted VPN server: an EC2 instance in a public subnet with a fixed Elastic IP.
 *
 * Everything the managed service does implicitly is spelled out here: the UDP listener in the
 * security group, a stable public address for client configs, key material fetched from Secrets
 * Manager at boot, SSM Session Manager instead of SSH, and a log group the CloudWatch agent ships
 * connection logs to. It is a single instance: an AZ failure or instance replacement drops every
 * session until a new instance boots (see the README for the HA options).
 */
export class SelfHostedVpnServer extends Construct {
  /** The VPN server instance. */
  readonly instance: ec2.IInstance;
  /** Group of the server; the target admits traffic from it. */
  readonly securityGroup: ec2.ISecurityGroup;
  /** Fixed public address written into client configurations. */
  readonly elasticIp: ec2.CfnEIP;
  /** Log group the CloudWatch agent ships the server's connection log to. */
  readonly logGroup: logs.ILogGroup;

  /** Creates the resources described above. */
  constructor(scope: Construct, id: string, props: SelfHostedVpnServerProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: props.logRetentionDays,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.logGroup = logGroup;

    const securityGroup = new ec2.SecurityGroup(this, 'Sg', {
      vpc: props.vpc,
      description: `${props.label} server`,
      // Package installs and AWS API calls go to the internet; tunnelled traffic leaves as the instance.
      allowAllOutbound: true,
    });
    for (const cidr of props.ingressCidrs) {
      securityGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.udp(props.port), `${props.label} clients`);
    }

    this.securityGroup = securityGroup;

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: `${props.label} server: Session Manager, key material and log shipping`,
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        // Secrets Manager appends a random 6-character suffix to the ARN.
        resources: props.secretNames.map((name) =>
          stack.formatArn({ service: 'secretsmanager', resource: 'secret', resourceName: `${name}-??????`, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME }),
        ),
      }),
    );
    if (props.parameterNames && props.parameterNames.length > 0) {
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: props.parameterNames.map((name) =>
            stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: name.replace(/^\//, '') }),
          ),
        }),
      );
    }
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
        resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:log-stream:*`],
      }),
    );

    this.instance = new ec2.Instance(this, 'Instance', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC, availabilityZones: [props.vpc.availabilityZones[0]] },
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: ubuntuImage(),
      securityGroup,
      role,
      requireImdsv2: true,
      blockDevices: [encryptedRootVolume()],
      userData: ec2.UserData.custom(props.userData(logGroup.logGroupName)),
      userDataCausesReplacement: true,
      // Source/destination check stays enabled: tunnelled packets are source-NATed to the instance's
      // own address, so the instance never forwards packets with a foreign source IP.
      sourceDestCheck: true,
    });

    // The AZ literal comes from the target VPC's subnet list (resolved at synth time), not a hand-written
    // value; a single-instance server has to sit in one AZ (see README "Ubuntu, one instance, Elastic IP").
    cdk.Validations.of(this.instance).acknowledge({
      id: 'CloudFormation-Validate::W3010',
      reason: 'Single-instance VPN server placed in the first AZ of the VPC it serves',
    });

    // Clients keep this address in their configuration; it survives stop/start and replacement.
    this.elasticIp = new ec2.CfnEIP(this, 'Eip', {
      domain: 'vpc',
      instanceId: this.instance.instanceId,
      tags: [{ key: 'Name', value: `${stack.stackName}-${props.label}` }],
    });
  }
}
