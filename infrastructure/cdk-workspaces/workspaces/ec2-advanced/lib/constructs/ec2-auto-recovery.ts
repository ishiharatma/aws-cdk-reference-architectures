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
 * Properties for Ec2AutoRecovery
 */
export interface Ec2AutoRecoveryProps {
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
   * Number of consecutive 1-minute periods the system status check must fail
   * before the auto-recovery action is triggered.
   * @default 2
   */
  readonly recoveryEvaluationPeriods?: number;
  /**
   * SNS topic to notify when auto-recovery is triggered (ALARM state)
   * and when the instance recovers (OK state).
   * When omitted, no notification is sent.
   */
  readonly notificationTopic?: sns.ITopic;
}

/**
 * EC2 Auto Recovery Construct
 *
 * A single EC2 instance with a CloudWatch alarm that automatically
 * recovers the instance when a system-level failure is detected.
 * Accessible via SSM Session Manager. No load balancer.
 *
 * Note: Auto-recovery is not supported on instances backed by instance store volumes.
 */
export class Ec2AutoRecovery extends Construct {
  public readonly instance: ec2.IInstance;
  public readonly recoveryAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: Ec2AutoRecoveryProps) {
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
      description: 'EC2 Auto-Recovery Instance ID',
    });

    // CloudWatch alarm: trigger auto-recovery on system status check failure
    const alarm = new cloudwatch.Alarm(this, 'AutoRecoveryAlarm', {
      alarmName: [props.project, props.environment, id, 'AutoRecovery'].join('-'),
      alarmDescription: 'Trigger EC2 auto-recovery when system status check fails',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/EC2',
        metricName: 'StatusCheckFailed_System',
        dimensionsMap: { InstanceId: instance.instanceId },
        statistic: 'Maximum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: props.recoveryEvaluationPeriods ?? 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new cloudwatch_actions.Ec2Action(
        cloudwatch_actions.Ec2InstanceAction.RECOVER
    ));
    if (props.notificationTopic) {
      // Notify when auto-recovery is triggered
      alarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
      // Notify when the instance has recovered
      alarm.addOkAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
    }
    this.recoveryAlarm = alarm;
  }
}
