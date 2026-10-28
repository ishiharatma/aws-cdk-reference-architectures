import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { CapacityProviderStrategyParams, FargateCapacityProvider, ServiceParams } from 'parameters/environments';

/** Length of the Fargate Spot interruption warning, and the Fargate cap on `stopTimeout`. */
export const SPOT_WARNING_SECONDS = 120;

const CONTAINER_PORT = 8080;
const APP_SOURCE = path.join(__dirname, '..', '..', 'src', 'app.py');

/**
 * Reject parameter combinations that the service would accept but that defeat the pattern.
 * Thrown at synth time so a bad environment file never reaches CloudFormation.
 */
export function validateServiceParams(params: ServiceParams): void {
  const strategies = params.capacityProviderStrategies;
  const providers = strategies.map((s) => s.capacityProvider);
  if (new Set(providers).size !== providers.length) {
    throw new Error('capacityProviderStrategies: each capacity provider may appear only once');
  }
  if (strategies.filter((s) => (s.base ?? 0) > 0).length > 1) {
    throw new Error('capacityProviderStrategies: only one capacity provider may have a base');
  }
  if (!strategies.some((s) => s.weight > 0)) {
    throw new Error('capacityProviderStrategies: at least one capacity provider needs a weight above 0');
  }
  if (params.stopTimeoutSeconds > SPOT_WARNING_SECONDS) {
    throw new Error(`stopTimeoutSeconds must be ${SPOT_WARNING_SECONDS} or less (Fargate limit)`);
  }
  if (params.drainSeconds >= params.stopTimeoutSeconds) {
    throw new Error('drainSeconds must be shorter than stopTimeoutSeconds, or the container is killed while draining');
  }
  if (params.deregistrationDelaySeconds >= SPOT_WARNING_SECONDS) {
    throw new Error(`deregistrationDelaySeconds must be below the ${SPOT_WARNING_SECONDS}-second Spot warning`);
  }
  if (params.availabilityZoneRebalancing === 'ENABLED' && params.maxHealthyPercent <= 100) {
    throw new Error('AZ rebalancing needs maxHealthyPercent above 100 (it starts a task before stopping one)');
  }
  const { minCapacity, maxCapacity } = params.autoScaling;
  if (minCapacity > params.desiredCount || params.desiredCount > maxCapacity) {
    throw new Error('desiredCount must be within autoScaling.minCapacity..maxCapacity');
  }
}

/**
 * Tasks per capacity provider for a given count: `base` first, then the rest by weight
 * (largest remainder). Matches the splits observed on ECS (6 -> 3/3, 9 -> 4/5 for base 2, 1:3).
 */
export function splitByStrategy(
  strategies: CapacityProviderStrategyParams[],
  count: number,
): Record<FargateCapacityProvider, number> {
  const result: Record<FargateCapacityProvider, number> = { FARGATE: 0, FARGATE_SPOT: 0 };
  let remaining = count;
  for (const s of strategies) {
    const base = Math.min(s.base ?? 0, remaining);
    result[s.capacityProvider] += base;
    remaining -= base;
  }
  const totalWeight = strategies.reduce((sum, s) => sum + s.weight, 0);
  const shares = strategies.map((s) => ({ s, exact: (remaining * s.weight) / totalWeight }));
  let assigned = 0;
  for (const { s, exact } of shares) {
    result[s.capacityProvider] += Math.floor(exact);
    assigned += Math.floor(exact);
  }
  const byFraction = [...shares].sort((a, b) => (b.exact % 1) - (a.exact % 1));
  for (let i = 0; i < remaining - assigned; i++) {
    result[byFraction[i].s.capacityProvider] += 1;
  }
  return result;
}

/** Properties for {@link MixedCapacityService}. */
export interface MixedCapacityServiceProps {
  readonly cluster: ecs.ICluster;
  readonly vpc: ec2.IVpc;
  readonly listener: elbv2.IApplicationListener;
  readonly albSecurityGroup: ec2.ISecurityGroup;
  readonly containerImage: string;
  readonly serviceName: string;
  readonly params: ServiceParams;
  readonly logRetentionDays: number;
  /** Number of AZs the tasks are spread over (subnets of the service). */
  readonly azCount: number;
}

/**
 * Fargate service whose tasks are split between FARGATE and FARGATE_SPOT by a capacity provider
 * strategy, spread across AZs (and moved back after an imbalance by AZ rebalancing), and drained
 * gracefully on SIGTERM so a Spot interruption does not drop requests.
 */
export class MixedCapacityService extends Construct {
  public readonly service: ecs.IFargateService;
  public readonly targetGroup: elbv2.IApplicationTargetGroup;
  public readonly logGroup: logs.ILogGroup;

  /** Validates the parameters, then creates the task definition, service, target group and scaling. */
  constructor(scope: Construct, id: string, props: MixedCapacityServiceProps) {
    super(scope, id);
    const p = props.params;
    validateServiceParams(p);

    // ECS spreads (and rebalances) each capacity provider on its own, so the total per AZ is only
    // even when every provider's task count is a multiple of the AZ count.
    const split = splitByStrategy(p.capacityProviderStrategies, p.desiredCount);
    const uneven = Object.entries(split).filter(([, n]) => n % props.azCount !== 0);
    if (uneven.length > 0) {
      cdk.Annotations.of(this).addWarningV2(
        'fgspot:uneven-az-split',
        `desiredCount ${p.desiredCount} splits into ${uneven.map(([cp, n]) => `${cp}=${n}`).join(', ')}, ` +
          `not a multiple of ${props.azCount} AZs: the tasks per AZ can stay uneven even with AZ rebalancing`,
      );
    }

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: props.logRetentionDays,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: p.cpu,
      memoryLimitMiB: p.memoryLimitMiB,
      // Fargate Spot does not run ARM64 tasks.
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    taskDefinition.addContainer('App', {
      image: ecs.ContainerImage.fromRegistry(props.containerImage),
      command: ['python', '-u', '-c', fs.readFileSync(APP_SOURCE, 'utf8')],
      environment: {
        PORT: String(CONTAINER_PORT),
        DRAIN_SECONDS: String(p.drainSeconds),
      },
      portMappings: [{ containerPort: CONTAINER_PORT, name: 'http', appProtocol: ecs.AppProtocol.http }],
      // Time between SIGTERM and SIGKILL; the Spot warning gives at most 120 seconds.
      stopTimeout: cdk.Duration.seconds(p.stopTimeoutSeconds),
      readonlyRootFilesystem: true,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'app', logGroup }),
    });

    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: 'Tasks: application port from the ALB only',
    });
    securityGroup.addIngressRule(props.albSecurityGroup, ec2.Port.tcp(CONTAINER_PORT), 'App port from the ALB');

    const service = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      serviceName: props.serviceName,
      taskDefinition,
      desiredCount: p.desiredCount,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [securityGroup],
      assignPublicIp: false,
      // No launchType: the strategy decides where each task runs.
      capacityProviderStrategies: p.capacityProviderStrategies.map((s) => ({
        capacityProvider: s.capacityProvider,
        base: s.base,
        weight: s.weight,
      })),
      availabilityZoneRebalancing:
        p.availabilityZoneRebalancing === 'ENABLED'
          ? ecs.AvailabilityZoneRebalancing.ENABLED
          : ecs.AvailabilityZoneRebalancing.DISABLED,
      minHealthyPercent: p.minHealthyPercent,
      maxHealthyPercent: p.maxHealthyPercent,
      circuitBreaker: { enable: true, rollback: true },
      platformVersion: ecs.FargatePlatformVersion.LATEST,
    });
    // The strategy names FARGATE / FARGATE_SPOT, registered by the cluster's
    // ClusterCapacityProviderAssociations. Without this dependency CloudFormation deletes the
    // association in parallel with the service and fails with "The specified capacity provider
    // is in use and cannot be removed".
    service.node.addDependency(props.cluster);

    this.targetGroup = props.listener.addTargets('Web', {
      port: CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      deregistrationDelay: cdk.Duration.seconds(p.deregistrationDelaySeconds),
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(10),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
    });

    const scaling = service.autoScaleTaskCount({
      minCapacity: p.autoScaling.minCapacity,
      maxCapacity: p.autoScaling.maxCapacity,
    });
    scaling.scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: p.autoScaling.targetCpuUtilizationPercent,
      scaleOutCooldown: cdk.Duration.seconds(60),
      scaleInCooldown: cdk.Duration.seconds(300),
    });

    this.service = service;
    this.logGroup = logGroup;
  }
}
