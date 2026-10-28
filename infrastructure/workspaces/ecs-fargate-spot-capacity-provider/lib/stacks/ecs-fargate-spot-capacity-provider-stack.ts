import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { WebAlb } from 'lib/constructs/web-alb';
import { MixedCapacityService } from 'lib/constructs/mixed-capacity-service';
import { TaskEventRecorder } from 'lib/constructs/task-event-recorder';

/** Properties for {@link EcsFargateSpotCapacityProviderStack}. */
export interface EcsFargateSpotCapacityProviderStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly envParams: EnvParams;
  readonly allowedIps: string[];
  readonly allowedIpv6s?: string[];
}

/**
 * VPC across three AZs, an ALB, and an ECS cluster whose service mixes FARGATE and FARGATE_SPOT
 * through a capacity provider strategy, with AZ rebalancing and Spot interruption recording.
 */
export class EcsFargateSpotCapacityProviderStack extends cdk.Stack {
  public readonly cluster: ecs.ICluster;
  public readonly service: MixedCapacityService;

  /** Creates the VPC, cluster, ALB, mixed-capacity service and event recording. */
  constructor(scope: Construct, id: string, props: EcsFargateSpotCapacityProviderStackProps) {
    super(scope, id, props);
    const p = props.envParams;
    const prefix = `${props.project}-${props.environment}-fgspot`;

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(p.network.vpcCidr),
      maxAzs: p.network.maxAzs,
      natGateways: p.network.natGateways,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });
    vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, 'FlowLogGroup', {
          retention: p.logRetentionDays,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      ),
      trafficType: ec2.FlowLogTrafficType.REJECT,
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: prefix,
      vpc,
      // Registers FARGATE and FARGATE_SPOT so services can name them in their strategy.
      enableFargateCapacityProviders: true,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });
    this.cluster = cluster;

    const alb = new WebAlb(this, 'Alb', {
      vpc,
      allowedIps: props.allowedIps,
      allowedIpv6s: props.allowedIpv6s,
      isAutoDeleteObject: props.isAutoDeleteObject,
    });

    this.service = new MixedCapacityService(this, 'Web', {
      cluster: this.cluster,
      vpc,
      listener: alb.listener,
      albSecurityGroup: alb.securityGroup,
      containerImage: p.containerImage,
      serviceName: `${prefix}-web`,
      params: p.service,
      logRetentionDays: p.logRetentionDays,
      azCount: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnets.length,
    });

    const recorder = new TaskEventRecorder(this, 'TaskEvents', {
      cluster: this.cluster,
      logGroupPrefix: prefix,
      retentionDays: p.logRetentionDays,
    });

    new cdk.CfnOutput(this, 'AlbUrl', { value: `http://${alb.loadBalancer.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new cdk.CfnOutput(this, 'ServiceName', { value: this.service.service.serviceName });
    new cdk.CfnOutput(this, 'TargetGroupArn', { value: this.service.targetGroup.targetGroupArn });
    new cdk.CfnOutput(this, 'AppLogGroup', { value: this.service.logGroup.logGroupName });
    new cdk.CfnOutput(this, 'SpotInterruptionLogGroup', { value: recorder.spotInterruptionLogGroup.logGroupName });
    new cdk.CfnOutput(this, 'TaskStoppedLogGroup', { value: recorder.taskStoppedLogGroup.logGroupName });
    new cdk.CfnOutput(this, 'ServiceActionLogGroup', { value: recorder.serviceActionLogGroup.logGroupName });
  }
}
