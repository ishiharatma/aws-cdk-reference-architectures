import * as cdk from 'aws-cdk-lib';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { Ec2DualEni } from 'lib/constructs/ec2-dual-eni';
import { dualEniNginxUserData } from 'src/nginx-userdata';

export interface Ec2DualEniStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly envParams: EnvParams;
  /**
   * CIDRs allowed to SSH into the management ENI.
   * Overrides envParams.managementAllowedCidrs when provided.
   */
  readonly managementAllowedCidrs?: string[];
}

/**
 * EC2 Dual ENI Stack
 *
 * Creates a VPC with a public subnet and an isolated management subnet,
 * then deploys an EC2 instance with two ENIs:
 *   - eth0: internet-facing (HTTP/HTTPS from anywhere) + Elastic IP
 *   - eth1: management (SSH from specified CIDRs only)
 *
 * This pattern demonstrates traffic-plane separation on a single instance,
 * a common topic in AWS networking certification exams (ANS-C01).
 *
 * Note: For modern workloads, prefer SSM Session Manager over SSH.
 *       This pattern is provided as a learning reference.
 */
export class Ec2DualEniStack extends cdk.Stack {
  public readonly ec2Instance: Ec2DualEni;

  constructor(scope: Construct, id: string, props: Ec2DualEniStackProps) {
    super(scope, id, props);

    const mgmtCidrs = props.managementAllowedCidrs?.length
      ? props.managementAllowedCidrs
      : props.envParams.managementAllowedCidrs;

    // VPC: public subnet for eth0, isolated subnet for eth1 (same AZ)
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Management',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    const publicSubnet = vpc.publicSubnets[0];
    const managementSubnet = vpc.isolatedSubnets[0];

    // Security group for eth0: HTTP and HTTPS from anywhere
    const webSg = new ec2.SecurityGroup(this, 'WebSecurityGroup', {
      vpc,
      description: 'eth0 — allow HTTP/HTTPS from internet',
      allowAllOutbound: true,
    });
    webSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from anywhere');
    webSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from anywhere');

    // Security group for eth1: SSH only from the specified management CIDRs
    const mgmtSg = new ec2.SecurityGroup(this, 'ManagementSecurityGroup', {
      vpc,
      description: 'eth1 — allow SSH from management CIDRs only',
      allowAllOutbound: false,
    });
    for (const cidr of mgmtCidrs) {
      mgmtSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(22), `SSH from ${cidr}`);
    }

    this.ec2Instance = new Ec2DualEni(this, 'Ec2DualEni', {
      project: props.project,
      environment: props.environment,
      publicSubnet,
      managementSubnet,
      webSecurityGroup: webSg,
      managementSecurityGroup: mgmtSg,
      instanceType: props.envParams.instanceType,
      rootVolumeSize: props.envParams.rootVolumeSize,
      userDataCommands: dualEniNginxUserData(),
    });

    new cdk.CfnOutput(this, 'WebUrl', {
      value: `http://${this.ec2Instance.elasticIp.ref}`,
      description: 'Web server URL (HTTP via eth0 EIP)',
    });
  }
}
