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
 * Properties for Ec2AsgMultiWarm
 */
export interface Ec2AsgMultiWarmProps {
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
   * Minimum number of in-service instances.
   * @default 2
   */
  readonly minCapacity?: number;
  /**
   * Maximum number of in-service instances (excluding warm pool).
   * Must be >= minCapacity.
   * @default same as minCapacity
   */
  readonly maxCapacity?: number;
  /**
   * Number of instances to keep pre-warmed in the warm pool.
   * These instances are started and hibernated, ready to be activated quickly
   * when the ASG needs to scale out.
   * @default 1
   */
  readonly warmPoolSize?: number;
  /**
   * The state of instances in the warm pool.
   * - HIBERNATED: RAM contents are saved to EBS; fastest resume (~10 sec).
   *   Requires hibinit-agent on the instance and sufficient EBS space (>= RAM size).
   *   Supported instance families: T3, C5, M5, R5, T4G, C6G, M6G, R6G, etc.
   * - STOPPED: Instance is stopped; fast startup (avoids full OS boot).
   * - RUNNING: Instance is running; immediate availability but incurs EC2 charges.
   * @default autoscaling.PoolState.HIBERNATED
   */
  readonly poolState?: autoscaling.PoolState;
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
   *
   * User data does NOT re-run on resume from hibernation — it only executes
   * on the first boot when the instance enters the warm pool.
   *
   * **Note on `ec2-hibinit-agent` for HIBERNATED pool state:**
   * - AL2023 **standard** AMI: hibernation agent is pre-installed. No action needed.
   * - AL2023 **minimal** AMI (released 2023.09.20 or later): install manually:
   *   `'sudo dnf install ec2-hibinit-agent'`, `'sudo systemctl start hibinit-agent'`
   * - @see https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/hibernation-enabled-AMI.html
   */
  readonly additionalUserData?: string[];
  /**
   * EBS root volume size in GiB.
   * When using HIBERNATED pool state, this must be larger than the instance RAM size
   * to store the hibernation image.
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
 * EC2 Auto Scaling Group with Warm Pool — Multi-AZ Construct
 *
 * An ASG behind an ALB with a pre-warmed pool of hibernated (or stopped) instances
 * that can be promoted to in-service within seconds on scale-out events.
 *
 * **Warm pool flow:**
 * 1. Instances in the warm pool are started and run user data once.
 * 2. They then enter the HIBERNATED (or STOPPED) state.
 * 3. On scale-out, ASG promotes a warm instance to in-service — no OS boot required.
 * 4. On scale-in, instances return to the warm pool (reuseOnScaleIn=true) instead
 *    of being terminated, preserving the initialized state.
 *
 * **Requirements for HIBERNATED state:**
 * - EBS-backed instance (enforced by this construct).
 * - EBS root volume must be encrypted (enforced by this construct).
 * - Root volume size must be > RAM size of the instance type.
 * - AMI must support hibernation:
 *   - AL2023 **standard** AMI: hibernation agent is pre-installed. No action needed.
 *   - AL2023 **minimal** AMI: install `ec2-hibinit-agent` via `additionalUserData`.
 *   - @see https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/hibernation-enabled-AMI.html
 */
export class Ec2AsgMultiWarm extends Construct {
  public readonly asg: autoscaling.AutoScalingGroup;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: Ec2AsgMultiWarmProps) {
    super(scope, id);

    const minCapacity = props.minCapacity ?? 2;
    const maxCapacity = props.maxCapacity ?? minCapacity;
    const warmPoolSize = props.warmPoolSize ?? 1;
    const poolState = props.poolState ?? autoscaling.PoolState.HIBERNATED;

    const userData = ec2.UserData.forLinux({ shebang: '#!/bin/bash' });
    if (props.additionalUserData) {
      userData.addCommands(...props.additionalUserData);
    }

    const instanceRole = new iam.Role(this, 'InstanceRole', {
      roleName: `${cdk.Stack.of(this).stackName}-WarmInstanceRole`,
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
      // hibernationConfigured is required for HIBERNATED pool state.
      // Setting it for STOPPED/RUNNING states causes no harm.
      hibernationConfigured: poolState === autoscaling.PoolState.HIBERNATED,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          mappingEnabled: true,
          volume: ec2.BlockDeviceVolume.ebs(props.rootVolumeSize ?? 8, {
            encrypted: true, // Required for hibernation
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            deleteOnTermination: true,
          }),
        },
      ],
      requireImdsv2: true,
      role: instanceRole,
    });

    // ASG: minCapacity in-service + warmPoolSize pre-warmed
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
        minInstancesInService: 1,
      }),
      // Notify on instance launch/terminate/error events
      // @see https://docs.aws.amazon.com/ja_jp/autoscaling/ec2/userguide/ec2-auto-scaling-sns-notifications.html#auto-scaling-sns-notifications
      notifications: props.notificationTopic
        ? [{ topic: props.notificationTopic, scalingEvents: autoscaling.ScalingEvents.ALL }]
        : undefined,
    });
    this.asg = asg;

    // Warm pool: pre-warmed instances ready for fast scale-out
    asg.addWarmPool({
      // Maximum number of instances to keep in the warm pool
      maxGroupPreparedCapacity: warmPoolSize,
      // Minimum instances always kept warm (0 = scale to 0 when not needed)
      minSize: 0,
      poolState,
      // Return instances to the warm pool on scale-in instead of terminating
      reuseOnScaleIn: true,
    });

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

    new cdk.CfnOutput(this, 'AsgName', {
      value: asg.autoScalingGroupName,
      description: `Auto Scaling Group Name (${minCapacity} in-service + ${warmPoolSize} warm pool, state: ${poolState})`,
    });

    if (props.notificationTopic) {
      // CloudWatch alarm: notify when ALB reports unhealthy instances
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

      // CloudWatch alarm: notify when CPU utilization is high
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

      // CloudWatch alarm: notify when ASG has fewer in-service instances than desired (launch failure)
      const launchFailureAlarm = new cloudwatch.Alarm(this, 'InstanceLaunchFailureAlarm', {
        alarmName: [props.project, props.environment, id, 'InstanceLaunchFailure'].join('-'),
        alarmDescription: `ASG in-service instance count dropped below ${minCapacity} (possible launch failure)`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/AutoScaling',
          metricName: 'GroupInServiceInstances',
          dimensionsMap: { AutoScalingGroupName: asg.autoScalingGroupName },
          statistic: 'Minimum',
          period: cdk.Duration.minutes(1),
        }),
        threshold: minCapacity,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
      launchFailureAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
      launchFailureAlarm.addOkAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
    }
  }
}
