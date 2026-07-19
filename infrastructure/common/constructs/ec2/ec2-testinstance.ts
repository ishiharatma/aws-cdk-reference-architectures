import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import {
    aws_ec2 as ec2,
    aws_events as events,
    aws_iam as iam
} from 'aws-cdk-lib';
import { Environment } from '../../parameters/environments';
import { C_RESOURCE } from '../../types';

/**
 * Properties for TestEC2Instance
 */
export interface TestEC2InstanceProps {
  readonly project: string;
  readonly environment: Environment;
  readonly vpc: ec2.IVpc;
  readonly additionalSecurityGroups?: ec2.ISecurityGroup[];
  /**
   * The subnet type where the EC2 instance will be launched.
   * @default ec2.SubnetType.PRIVATE_WITH_EGRESS
   */
  readonly targetSubnetType?: ec2.SubnetType;
  /**
   * The instance type for the EC2 instance.
   * @default ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO)
   */
  readonly instanceType?: ec2.InstanceType;
  /**
   * Additional user data commands to execute on instance launch.
   * These commands will be appended to the default user data.
   * @default - No additional commands
   */
  readonly additionalUserData?: string[];
  /**
   * Cron expression for stopping the instance.
   * If not provided, the instance will not be stopped automatically.
   */
  readonly stopCronSchedule?: string;
  /**
   * Cron expression for starting the instance.
   * If not provided, the instance will not be started automatically.
   */  
  readonly startCronSchedule?: string;
  /**
   * Whether to use a Spot Instance for the EC2 instance.
   * @default false
   */
  readonly isSpotInstance?: boolean;
  /**
   * Maximum price for spot instance (USD per hour).
   * If not specified, defaults to on-demand price.
   * @default - On-demand price
   */
  readonly spotMaxPrice?: string;
}

export class TestInstance extends Construct {
  public readonly instance: ec2.IInstance;
  public readonly securityGroup: ec2.ISecurityGroup;
  public readonly subnet: ec2.ISubnet;

  constructor(scope: Construct, id: string, props: TestEC2InstanceProps) {
    super(scope, id);

    //const accountId = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    const isSpotInstance = props.isSpotInstance ?? false;

    // Create a security group for your EC2 instance
    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      allowAllOutbound: true,    
    });
    // allow VPC internal traffic
    this.securityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.allTraffic(),
      'Allow all traffic within VPC'
    );
    new cdk.CfnOutput(this, 'EC2SecurityGroupId', {
      value: this.securityGroup.securityGroupId,
    });

    // Create user data for the EC2 instance
    const userData = ec2.UserData.forLinux({ shebang: '#!/bin/bash' });
    userData.addCommands(
      //'dnf install boxes -y',
      'echo "Test EC2 Instance" > /etc/update-motd.d/00-test-instance'
    );
    if (props.additionalUserData) {
      userData.addCommands(...props.additionalUserData);
    }
    // Create a key pair for SSH access
    const keyPair = new ec2.KeyPair(this, 'KeyPair', {
      keyPairName: `${id}-ec2-KeyPair`,
      type: ec2.KeyPairType.ED25519,
      format: ec2.KeyPairFormat.PEM,
    });
    new cdk.CfnOutput(this, 'EC2InstanceKeyPairId', {
      value: keyPair.keyPairId,
    });
    const targetSubnet = props.vpc.selectSubnets({
      subnetType: props.targetSubnetType ?? ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnets[0];
    this.subnet = targetSubnet;
    new cdk.CfnOutput(this, 'EC2InstanceSubnetId', {
      value: targetSubnet.subnetId,
    });
    // Create an EC2 instance for connection testing
    const instance = new ec2.Instance(this, C_RESOURCE, {
      vpc: props.vpc,
      instanceName: [id, 'test', 'instance'].join('/') ,
      instanceType: props.instanceType ?? ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        edition: ec2.AmazonLinuxEdition.STANDARD,
        cpuType: ec2.AmazonLinuxCpuType.ARM_64 //X86_64, 
      }),
      vpcSubnets: { subnets: [targetSubnet] },
      securityGroup: this.securityGroup,
      blockDevices: [
          {
              deviceName: '/dev/xvda',
              mappingEnabled: true,
              volume: ec2.BlockDeviceVolume.ebs(8, {
                  encrypted: true,
                  volumeType: ec2.EbsDeviceVolumeType.GP3,
                  deleteOnTermination: true,
              }),
          },
      ],
      //availabilityZone: 'ap-northeast-1a',
      ssmSessionPermissions: true, // Used by SSM session manager
      userData: userData,
      // Security Hub EC2.8
      // https://docs.aws.amazon.com/ja_jp/securityhub/latest/userguide/ec2-controls.html#ec2-8
      requireImdsv2: true,
      keyPair
    });
    this.instance = instance;
    if (props.additionalSecurityGroups) {
      props.additionalSecurityGroups.forEach((sg) => {
        instance.addSecurityGroup(sg);
      });
    }

    new cdk.CfnOutput(this, "EC2InstanceId", {
        value: this.instance.instanceId,
        description: "Test Instance",
    });

    // Create EventBridge rules for starting/stopping the instance based on cron schedules
    if (props.startCronSchedule && props.stopCronSchedule && !isSpotInstance) {
      
      // AwsSolutions-IAM4
      const role = new iam.Role(this, `InstanceStartStopRole`, {
        roleName: [props.project, props.environment, 'InstanceStartStop', this.instance.instanceId].join('-'),
        assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
      });
      role.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonSSMAutomationRole')
      );
      // 起動スケジュール
      new events.CfnRule(this, `EC2StartRule`, {
        name: [props.project, props.environment, 'EC2StartRule', this.instance.instanceId].join('-'),
        description: `${this.instance.instanceId} ${props.startCronSchedule} Start`,
        scheduleExpression: props.startCronSchedule,
        targets: [{
          arn: `arn:aws:ssm:${region}::automation-definition/AWS-StartEC2Instance:$DEFAULT`,
          id: 'TargetEC2Instance1',
          input: `{"InstanceId": ["${this.instance.instanceId}"]}`,
          roleArn: role.roleArn
        }]
      });
      
      // 停止スケジュール
      new events.CfnRule(this, `EC2StopRule`, {
        name: [props.project, props.environment, 'EC2StopRule', this.instance.instanceId].join('-'),
        description: `${this.instance.instanceId} ${props.stopCronSchedule} Stop`,
        scheduleExpression: props.stopCronSchedule,
        targets: [{
          arn: `arn:aws:ssm:${region}::automation-definition/AWS-StopEC2Instance:$DEFAULT`,
          id: 'TargetEC2Instance1',
          input: `{"InstanceId": ["${this.instance.instanceId}"]}`,
          roleArn: role.roleArn
        }]
      });
    }
  }
}
