import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { AppServiceParams, TestTrafficHeader } from 'parameters/environments';

/** Named container port the gateway connector refers to. */
export const GATEWAY_PORT_NAME = 'web';

/** Properties for {@link GatewayConnectedService}. */
export interface GatewayConnectedServiceProps {
  readonly cluster: ecs.ICluster;
  readonly serviceName: string;
  readonly service: AppServiceParams;
  readonly containerImage: string;
  readonly version: string;
  /** Echoed back in the response so a test request can be told apart from a normal one. */
  readonly testTrafficHeader: TestTrafficHeader;
  readonly removalPolicy: cdk.RemovalPolicy;
}

/**
 * A Fargate service that opts in to the gateways associated with its cluster.
 *
 * The application team only declares a gateway connector (named port, access type filter, health check).
 * It needs no load balancer, listener, certificate or security group rule: ECS creates the per-service
 * target groups, listener rules, certificate, `*.ecs.<region>.on.aws` hostname and an ingress-only security group.
 */
export class GatewayConnectedService extends Construct {
  readonly service: ecs.IBaseService;

  constructor(scope: Construct, id: string, props: GatewayConnectedServiceProps) {
    super(scope, id);
    const { service } = props;

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: props.serviceName,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });

    // nginx answers every path with who served the request: service, version, task and the Host header
    // the shared ALB routed on. `\$` keeps nginx variables out of the shell expansion.
    const headerVariable = `$http_${props.testTrafficHeader.name.toLowerCase().replace(/-/g, '_')}`;
    const startScript = [
      'cat > /etc/nginx/conf.d/default.conf <<EOF',
      'server {',
      '  listen 80;',
      '  location / {',
      '    default_type application/json;',
      `    return 200 '{"service":"$SERVICE","version":"$VERSION","task":"$(hostname)","host":"\\$host","testHeader":"\\${headerVariable}"}\\n';`,
      '  }',
      '}',
      'EOF',
      "exec nginx -g 'daemon off;'",
    ].join('\n');

    taskDefinition.addContainer('app', {
      image: ecs.ContainerImage.fromRegistry(props.containerImage),
      portMappings: [{ name: GATEWAY_PORT_NAME, containerPort: 80, appProtocol: ecs.AppProtocol.http }],
      environment: { SERVICE: service.name, VERSION: props.version },
      entryPoint: ['/bin/sh', '-c'],
      command: [startScript],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: service.name,
        logGroup: new logs.LogGroup(this, 'LogGroup', {
          logGroupName: `/ecs/${props.serviceName}`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: props.removalPolicy,
        }),
      }),
    });

    // Tasks get no inbound rule here: ECS attaches its own security group that admits only the gateway ALB.
    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.cluster.vpc,
      description: `${props.serviceName} tasks (ingress is managed by the ECS gateway)`,
    });

    const strategy = ecs.DeploymentStrategy[service.deploymentStrategy];
    const fargateService = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      serviceName: props.serviceName,
      taskDefinition,
      desiredCount: service.desiredCount,
      minHealthyPercent: 100,
      securityGroups: [securityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { enable: true, rollback: true },
      deploymentStrategy: strategy,
      bakeTime: service.bakeTimeMinutes !== undefined ? cdk.Duration.minutes(service.bakeTimeMinutes) : undefined,
      canaryConfiguration: service.canary && {
        stepPercent: service.canary.stepPercent,
        stepBakeTime: cdk.Duration.minutes(service.canary.bakeMinutes),
      },
      // Set explicitly: the service default only applies at creation (see ecs-fargate-spot-capacity-provider).
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.ENABLED,
    });

    // AWS::ECS::Service.GatewayConnectors has no L2/L1 property in aws-cdk-lib yet.
    // The health check is fixed at creation for ROLLING services (a change replaces the target group).
    const connector: Record<string, unknown> = {
      PortName: GATEWAY_PORT_NAME,
      HealthCheck: {
        HealthCheckPath: '/',
        HealthCheckIntervalSeconds: 10,
        HealthCheckTimeoutSeconds: 5,
        HealthyThresholdCount: 2,
        UnhealthyThresholdCount: 3,
        Matcher: { HttpCode: '200' },
      },
    };
    if (service.accessTypes) {
      connector.Filters = { AccessTypes: service.accessTypes };
    }
    this.service = fargateService;
    const cfnService = fargateService.node.defaultChild as ecs.CfnService;
    cfnService.addPropertyOverride('GatewayConnectors', [connector]);
    cdk.Validations.of(cfnService).acknowledge({
      id: 'CloudFormation-Validate::F3002',
      reason: 'cfn-lint schema predates AWS::ECS::Service GatewayConnectors; CloudFormation accepts it.',
    });
  }
}
