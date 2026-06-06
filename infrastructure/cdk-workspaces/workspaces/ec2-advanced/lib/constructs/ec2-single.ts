import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import {
  aws_ec2 as ec2,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatch_actions,
  aws_sns as sns,
} from 'aws-cdk-lib';
import { Environment } from '@common/parameters/environments';
import { C_RESOURCE } from '@common/constants';

/**
 * Properties for Ec2Single
 */
export interface Ec2SingleProps {
  readonly project: string;
  readonly environment: Environment;
  readonly vpc: ec2.IVpc;
  readonly securityGroup: ec2.ISecurityGroup;
  /** Instance type (e.g. ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO)) */
  readonly instanceType: ec2.InstanceType;
  /** Machine image (AMI) */
  readonly machineImage: ec2.IMachineImage;
  /**
   * The subnet type where the instance will be launched.
   * @default ec2.SubnetType.PRIVATE_WITH_EGRESS
   */
  readonly subnetType?: ec2.SubnetType;
  /**
   * Additional user data commands to execute on instance launch.
   */
  readonly additionalUserData?: string[];
  /**
   * EBS root volume size in GiB.
   * @default 8
   */
  readonly rootVolumeSize?: number;
  /**
   * SNS topic to notify when an EC2 status check fails.
   * Alerts on both system-level and instance-level status check failures.
   * When omitted, no notification is sent.
   */
  readonly notificationTopic?: sns.ITopic;
}

/**
 * EC2 Single Instance Construct
 *
 * A single EC2 instance accessible via SSM Session Manager.
 * No load balancer. Suitable for simple workloads or testing.
 */
export class Ec2Single extends Construct {
  public readonly instance: ec2.IInstance;

  constructor(scope: Construct, id: string, props: Ec2SingleProps) {
    super(scope, id);

    const userData = ec2.UserData.forLinux({ shebang: '#!/bin/bash' });
    if (props.additionalUserData) {
      userData.addCommands(...props.additionalUserData);
    }

    const instance = new ec2.Instance(this, C_RESOURCE, {
      vpc: props.vpc,
      instanceType: props.instanceType,
      machineImage: props.machineImage,
      securityGroup: props.securityGroup,
      vpcSubnets: { subnetType: props.subnetType ?? ec2.SubnetType.PRIVATE_WITH_EGRESS },
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          mappingEnabled: true,
          volume: ec2.BlockDeviceVolume.ebs(props.rootVolumeSize ?? 8, {
            encrypted: true,
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            deleteOnTermination: true,
          }),
        },
      ],
      ssmSessionPermissions: true,
      requireImdsv2: true,
      userData,
    });
    this.instance = instance;

    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 Single Instance ID',
    });

    // CloudWatch alarm: notify when either system or instance status check fails
    if (props.notificationTopic) {
      const statusAlarm = new cloudwatch.Alarm(this, 'StatusCheckAlarm', {
        alarmName: [props.project, props.environment, id, 'StatusCheckFailed'].join('-'),
        alarmDescription: 'EC2 instance status check (system or instance level) failed',
        metric: new cloudwatch.Metric({
          namespace: 'AWS/EC2',
          metricName: 'StatusCheckFailed',
          dimensionsMap: { InstanceId: instance.instanceId },
          statistic: 'Maximum',
          period: cdk.Duration.minutes(1),
        }),
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      statusAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
      statusAlarm.addOkAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
    }
  }
}
