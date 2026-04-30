import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import {
  aws_ec2 as ec2,
  aws_autoscaling as autoscaling,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatch_actions,
  aws_sns as sns,
} from 'aws-cdk-lib';
import { Environment } from '@common/parameters/environments';
import { C_RESOURCE } from '@common/constants';

/**
 * Properties for Ec2AsgMulti
 */
export interface Ec2AsgMultiProps {
  readonly project: string;
  readonly environment: Environment;
  readonly vpc: ec2.IVpc;
  readonly securityGroup: ec2.ISecurityGroup;
  /** Instance type (e.g. ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO)) */
  readonly instanceType: ec2.InstanceType;
  /** Machine image (AMI) */
  readonly machineImage: ec2.IMachineImage;
  /** ALB listener to register the ASG as a target */
  readonly listener: elbv2.IApplicationListener;
  /**
   * Minimum number of instances.
   * @default 2
   */
  readonly minCapacity?: number;
  /**
   * Maximum number of instances.
   * @default 2
   */
  readonly maxCapacity?: number;
  /**
   * The port the instances listen on.
   * @default 80
   */
  readonly instancePort?: number;
  /**
   * Health check path for the ALB target group.
   * @default '/'
   */
  readonly healthCheckPath?: string;
  /**
   * The subnet type where the instances will be launched.
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
   * SNS topic to receive ASG instance launch/terminate event notifications
   * and ALB unhealthy host count alerts.
   * When omitted, no notifications are sent.
   */
  readonly notificationTopic?: sns.ITopic;
}

/**
 * EC2 Auto Scaling Group — Always 2 Instances Construct
 *
 * An ASG with min=2 / max=2 / desired=2 behind an ALB, distributed
 * across multiple Availability Zones. This provides high availability:
 * if one AZ fails, the remaining instance continues serving traffic.
 * Suitable for production workloads requiring AZ-level redundancy.
 */
export class Ec2AsgMulti extends Construct {
  public readonly asg: autoscaling.AutoScalingGroup;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: Ec2AsgMultiProps) {
    super(scope, id);

    const minCapacity = props.minCapacity ?? 2;
    const maxCapacity = props.maxCapacity ?? 2;

    const userData = ec2.UserData.forLinux({ shebang: '#!/bin/bash' });
    if (props.additionalUserData) {
      userData.addCommands(...props.additionalUserData);
    }

    const instanceRole = new iam.Role(this, 'InstanceRole', {
      roleName: `${cdk.Stack.of(this).stackName}-InstanceRole`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      instanceType: props.instanceType,
      machineImage: props.machineImage,
      securityGroup: props.securityGroup,
      userData,
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
      requireImdsv2: true,
      role: instanceRole,
    });

    // Always 2 instances distributed across AZs for high availability
    const asg = new autoscaling.AutoScalingGroup(this, C_RESOURCE, {
      vpc: props.vpc,
      launchTemplate,
      minCapacity,
      maxCapacity,
      desiredCapacity: minCapacity,
      vpcSubnets: { subnetType: props.subnetType ?? ec2.SubnetType.PRIVATE_WITH_EGRESS },
      healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
        additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
        gracePeriod: cdk.Duration.seconds(60),
      }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        minInstancesInService: 1, // Keep at least 1 instance healthy during rolling updates
      }),
      // Notify on instance launch/terminate/error events
      notifications: props.notificationTopic
        ? [{ topic: props.notificationTopic, scalingEvents: autoscaling.ScalingEvents.ALL }]
        : undefined,
    });
    this.asg = asg;

    // Attach to ALB listener
    this.targetGroup = props.listener.addTargets('AsgTargets', {
      port: props.instancePort ?? 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [asg],
      healthCheck: {
        path: props.healthCheckPath ?? '/',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // CloudWatch alarm: notify when ALB reports unhealthy instances
    if (props.notificationTopic) {
      const unhealthyAlarm = new cloudwatch.Alarm(this, 'UnhealthyHostAlarm', {
        alarmName: [props.project, props.environment, id, 'UnhealthyHost'].join('-'),
        alarmDescription: 'ALB target group has unhealthy instances',
        metric: this.targetGroup.metrics.unhealthyHostCount({
          period: cdk.Duration.minutes(1),
          statistic: 'Maximum',
        }),
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      unhealthyAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
      unhealthyAlarm.addOkAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
    }

    new cdk.CfnOutput(this, 'AsgName', {
      value: asg.autoScalingGroupName,
      description: `Auto Scaling Group Name (always ${minCapacity} instances across AZs)`,
    });

    // CloudWatch alarm: notify when CPU utilization is high
    if (props.notificationTopic) {
      const cpuAlarm = new cloudwatch.Alarm(this, 'CpuAlarm', {
        alarmName: [props.project, props.environment, id, 'HighCPU'].join('-'),
        alarmDescription: 'ASG instance CPU utilization is high',
        metric: new cloudwatch.Metric({
          namespace: 'AWS/EC2',
          metricName: 'CPUUtilization',
          dimensionsMap: { AutoScalingGroupName: asg.autoScalingGroupName },
          statistic: 'Average',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 80,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      cpuAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
      cpuAlarm.addOkAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
    }
  }
}
