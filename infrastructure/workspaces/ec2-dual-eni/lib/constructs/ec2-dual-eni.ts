import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import {
  aws_ec2 as ec2,
  aws_iam as iam,
} from 'aws-cdk-lib';
import { C_RESOURCE } from '@common/constants';

export interface Ec2DualEniProps {
  readonly project: string;
  readonly environment: string;
  /** Instance type. @default t4g.micro */
  readonly instanceType?: ec2.InstanceType;
  /** Machine image (AMI). @default Amazon Linux 2023 ARM64 */
  readonly machineImage?: ec2.IMachineImage;
  /** Public subnet where the internet-facing ENI (eth0) will be placed. */
  readonly publicSubnet: ec2.ISubnet;
  /** Isolated subnet where the management ENI (eth1) will be placed. */
  readonly managementSubnet: ec2.ISubnet;
  /** Security group for eth0 (internet-facing: HTTP/HTTPS). */
  readonly webSecurityGroup: ec2.ISecurityGroup;
  /** Security group for eth1 (management: SSH from restricted CIDRs). */
  readonly managementSecurityGroup: ec2.ISecurityGroup;
  /** User data commands to run on first boot. */
  readonly userDataCommands?: string[];
  /** Root EBS volume size in GiB. @default 8 */
  readonly rootVolumeSize?: number;
}

/**
 * EC2 Dual ENI Construct
 *
 * Creates a single EC2 instance with two network interfaces:
 *   eth0 — internet-facing ENI in a public subnet, with an Elastic IP.
 *           Security group allows HTTP (80) and HTTPS (443) from anywhere.
 *   eth1 — management ENI in an isolated subnet.
 *           Security group allows SSH (22) only from the specified CIDR ranges.
 *
 * SSM Session Manager is also enabled via an IAM managed policy so the instance
 * can be accessed without opening SSH on eth0.
 */
export class Ec2DualEni extends Construct {
  public readonly instanceId: string;
  public readonly elasticIp: ec2.CfnEIP;
  public readonly primaryEni: ec2.CfnNetworkInterface;
  public readonly managementEni: ec2.CfnNetworkInterface;

  constructor(scope: Construct, id: string, props: Ec2DualEniProps) {
    super(scope, id);

    const namePrefix = `${props.project}-${props.environment}`;

    // IAM role — grants SSM Session Manager access
    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    const instanceProfile = new iam.CfnInstanceProfile(this, 'InstanceProfile', {
      roles: [role.roleName],
    });

    // eth0: internet-facing ENI (public subnet)
    this.primaryEni = new ec2.CfnNetworkInterface(this, 'PrimaryENI', {
      subnetId: props.publicSubnet.subnetId,
      groupSet: [props.webSecurityGroup.securityGroupId],
      description: `${namePrefix} eth0 — internet-facing`,
      sourceDestCheck: true,
      tags: [{ key: 'Name', value: `${namePrefix}-eth0-internet` }],
    });

    // eth1: management ENI (isolated subnet)
    this.managementEni = new ec2.CfnNetworkInterface(this, 'ManagementENI', {
      subnetId: props.managementSubnet.subnetId,
      groupSet: [props.managementSecurityGroup.securityGroupId],
      description: `${namePrefix} eth1 — management (SSH)`,
      sourceDestCheck: true,
      tags: [{ key: 'Name', value: `${namePrefix}-eth1-management` }],
    });

    // Elastic IP for eth0 (internet-facing)
    this.elasticIp = new ec2.CfnEIP(this, 'EIP', {
      domain: 'vpc',
      tags: [{ key: 'Name', value: `${namePrefix}-eip` }],
    });

    // Associate EIP with the primary ENI
    new ec2.CfnEIPAssociation(this, 'EIPAssociation', {
      networkInterfaceId: this.primaryEni.ref,
      allocationId: this.elasticIp.attrAllocationId,
    });

    // UserData
    const userDataLines = ['#!/bin/bash', ...(props.userDataCommands ?? [])];
    const userDataEncoded = cdk.Fn.base64(userDataLines.join('\n'));

    // Machine image
    const ami = (props.machineImage ?? ec2.MachineImage.latestAmazonLinux2023({
      cpuType: ec2.AmazonLinuxCpuType.ARM_64,
    })).getImage(this);

    // EC2 instance — network interfaces reference the two ENIs above
    const cfnInstance = new ec2.CfnInstance(this, C_RESOURCE, {
      imageId: ami.imageId,
      instanceType: (props.instanceType ?? ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO)).toString(),
      iamInstanceProfile: instanceProfile.ref,
      networkInterfaces: [
        {
          deviceIndex: '0',
          networkInterfaceId: this.primaryEni.ref,
        },
        {
          deviceIndex: '1',
          networkInterfaceId: this.managementEni.ref,
        },
      ],
      blockDeviceMappings: [
        {
          deviceName: '/dev/xvda',
          ebs: {
            encrypted: true,
            volumeSize: props.rootVolumeSize ?? 8,
            volumeType: 'gp3',
            deleteOnTermination: true,
          },
        },
      ],
      metadataOptions: {
        httpEndpoint: 'enabled',
        httpTokens: 'required', // IMDSv2
        httpPutResponseHopLimit: 1,
      },
      userData: userDataEncoded,
      tags: [{ key: 'Name', value: `${namePrefix}-instance` }],
    });

    this.instanceId = cfnInstance.ref;

    new cdk.CfnOutput(this, 'InstanceId', {
      value: cfnInstance.ref,
      description: 'EC2 instance ID',
    });
    new cdk.CfnOutput(this, 'ElasticIP', {
      value: this.elasticIp.ref,
      description: 'Elastic IP (eth0 — public web access)',
    });
    new cdk.CfnOutput(this, 'ManagementPrivateIP', {
      value: this.managementEni.attrPrimaryPrivateIpAddress,
      description: 'Management ENI private IP (eth1 — SSH access)',
    });
  }
}
