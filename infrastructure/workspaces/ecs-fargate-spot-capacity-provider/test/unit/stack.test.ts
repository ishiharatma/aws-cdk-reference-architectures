import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { CapacityProviderStrategyParams, ServiceParams } from 'parameters/environments';
import { splitByStrategy, validateServiceParams } from 'lib/constructs/mixed-capacity-service';
import { buildStack, clientIp, testParams } from '../helpers/stack';

describe('EcsFargateSpotCapacityProviderStack', () => {
  const template = Template.fromStack(buildStack());

  const serviceProps = () => {
    const services = Object.values(template.findResources('AWS::ECS::Service'));
    expect(services).toHaveLength(1);
    return services[0].Properties;
  };

  describe('network', () => {
    test('spans three AZs with public and private subnets', () => {
      template.resourceCountIs('AWS::EC2::Subnet', 6);
      template.resourceCountIs('AWS::EC2::NatGateway', 1);
    });

    test('records rejected traffic in VPC flow logs', () => {
      template.hasResourceProperties('AWS::EC2::FlowLog', { TrafficType: 'REJECT', LogDestinationType: 'cloud-watch-logs' });
    });
  });

  describe('cluster', () => {
    test('registers FARGATE and FARGATE_SPOT capacity providers', () => {
      template.hasResourceProperties('AWS::ECS::ClusterCapacityProviderAssociations', {
        CapacityProviders: Match.arrayEquals(['FARGATE', 'FARGATE_SPOT']),
      });
    });

    test('enables Container Insights with enhanced observability', () => {
      template.hasResourceProperties('AWS::ECS::Cluster', {
        ClusterSettings: [{ Name: 'containerInsights', Value: 'enhanced' }],
      });
    });
  });

  describe('capacity provider strategy', () => {
    test('keeps the base on FARGATE and weights the rest 1:3 towards FARGATE_SPOT', () => {
      expect(serviceProps().CapacityProviderStrategy).toEqual([
        { CapacityProvider: 'FARGATE', Base: 2, Weight: 1 },
        { CapacityProvider: 'FARGATE_SPOT', Weight: 3 },
      ]);
    });

    test('service depends on the capacity provider association (create and delete order)', () => {
      const [associationId] = Object.keys(template.findResources('AWS::ECS::ClusterCapacityProviderAssociations'));
      const [service] = Object.values(template.findResources('AWS::ECS::Service'));
      expect(service.DependsOn).toContain(associationId);
    });

    test('sets no launch type (a strategy and a launch type are mutually exclusive)', () => {
      expect(serviceProps().LaunchType).toBeUndefined();
    });

    test('maps an all-Spot strategy without a base', () => {
      const t = Template.fromStack(
        buildStack({ service: { capacityProviderStrategies: [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }] } }),
      );
      t.hasResourceProperties('AWS::ECS::Service', {
        CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE_SPOT', Weight: 1 }],
      });
    });
  });

  describe('AZ balance', () => {
    test('enables AZ rebalancing explicitly instead of relying on the service default', () => {
      expect(serviceProps().AvailabilityZoneRebalancing).toBe('ENABLED');
    });

    test('allows 200% during deployments so rebalancing can start a task before stopping one', () => {
      expect(serviceProps().DeploymentConfiguration).toMatchObject({
        MinimumHealthyPercent: 100,
        MaximumPercent: 200,
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      });
    });

    test('runs tasks in the private subnets of all three AZs without public IPs', () => {
      const vpcConfig = serviceProps().NetworkConfiguration.AwsvpcConfiguration;
      expect(vpcConfig.AssignPublicIp).toBe('DISABLED');
      expect(vpcConfig.Subnets).toHaveLength(3);
    });

    test('can be turned off per environment', () => {
      const t = Template.fromStack(buildStack({ service: { availabilityZoneRebalancing: 'DISABLED' } }));
      t.hasResourceProperties('AWS::ECS::Service', { AvailabilityZoneRebalancing: 'DISABLED' });
    });
  });

  describe('graceful shutdown for Spot interruptions', () => {
    test('container gets the full 120-second Spot warning before SIGKILL', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: [Match.objectLike({ StopTimeout: 120 })],
      });
    });

    test('application drains for the configured seconds', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: [
          Match.objectLike({ Environment: Match.arrayWith([{ Name: 'DRAIN_SECONDS', Value: '15' }]) }),
        ],
      });
    });

    test('target group deregisters within the Spot warning and checks /health', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        TargetType: 'ip',
        Port: 8080,
        HealthCheckPath: '/health',
        TargetGroupAttributes: Match.arrayWith([{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }]),
      });
    });

    test('task definition is x86_64 (Fargate Spot does not run ARM64)', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' },
        Cpu: '256',
        Memory: '512',
      });
    });

    test('container root filesystem is read-only', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: [Match.objectLike({ ReadonlyRootFilesystem: true })],
      });
    });
  });

  describe('auto scaling', () => {
    test('scales between min and max on CPU', () => {
      template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', { MinCapacity: 6, MaxCapacity: 12 });
      template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
        TargetTrackingScalingPolicyConfiguration: Match.objectLike({
          TargetValue: 60,
          PredefinedMetricSpecification: { PredefinedMetricType: 'ECSServiceAverageCPUUtilization' },
        }),
      });
    });
  });

  describe('ALB', () => {
    test('only the allowed client IP reaches port 80', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'ALB: HTTP from the allowed client IPs only',
        SecurityGroupIngress: [Match.objectLike({ CidrIp: `${clientIp}/32`, FromPort: 80, ToPort: 80 })],
      });
    });

    test('adds IPv6 rules when IPv6 addresses are given', () => {
      const t = Template.fromStack(buildStack({ allowedIpv6s: ['2001:db8::1'] }));
      t.hasResourceProperties('AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: Match.arrayWith([Match.objectLike({ CidrIpv6: '2001:db8::1/128' })]),
      });
    });

    test('tasks accept the application port from the ALB security group only', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        FromPort: 8080,
        ToPort: 8080,
        SourceSecurityGroupId: Match.anyValue(),
      });
    });

    test('writes access logs and drops invalid header fields', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Scheme: 'internet-facing',
        LoadBalancerAttributes: Match.arrayWith([{ Key: 'access_logs.s3.enabled', Value: 'true' }]),
      });
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        LoadBalancerAttributes: Match.arrayWith([{ Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' }]),
      });
    });
  });

  describe('task event recording', () => {
    test('captures Spot interruption warnings by stop code', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: Match.objectLike({
          'detail-type': ['ECS Task State Change'],
          detail: Match.objectLike({ stopCode: ['TerminationNotice'] }),
        }),
      });
    });

    test('captures every stopped task and service action', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: Match.objectLike({ detail: Match.objectLike({ lastStatus: ['STOPPED'] }) }),
      });
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: Match.objectLike({ 'detail-type': ['ECS Service Action'] }),
      });
    });

    test('event log groups live under /aws/events/ with retention', () => {
      for (const suffix of ['spot-interruptions', 'task-stopped', 'service-actions']) {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
          LogGroupName: `/aws/events/test-test-fgspot/${suffix}`,
          RetentionInDays: 7,
        });
      }
    });
  });
});

describe('validateServiceParams', () => {
  const base = (): ServiceParams => testParams().service;
  const withOverrides = (overrides: Partial<ServiceParams>) => () => validateServiceParams({ ...base(), ...overrides });

  test('accepts the test parameters', () => {
    expect(withOverrides({})).not.toThrow();
  });

  test('rejects a duplicated capacity provider', () => {
    expect(
      withOverrides({
        capacityProviderStrategies: [
          { capacityProvider: 'FARGATE', weight: 1 },
          { capacityProvider: 'FARGATE', weight: 1 },
        ],
      }),
    ).toThrow(/only once/);
  });

  test('rejects a base on more than one provider', () => {
    expect(
      withOverrides({
        capacityProviderStrategies: [
          { capacityProvider: 'FARGATE', base: 1, weight: 1 },
          { capacityProvider: 'FARGATE_SPOT', base: 1, weight: 1 },
        ],
      }),
    ).toThrow(/only one capacity provider may have a base/);
  });

  test('rejects a strategy with no weight', () => {
    expect(withOverrides({ capacityProviderStrategies: [{ capacityProvider: 'FARGATE', base: 2, weight: 0 }] })).toThrow(
      /weight above 0/,
    );
  });

  test('rejects a stop timeout above the 120-second Fargate limit', () => {
    expect(withOverrides({ stopTimeoutSeconds: 121 })).toThrow(/120 or less/);
  });

  test('rejects draining as long as the stop timeout', () => {
    expect(withOverrides({ drainSeconds: 120 })).toThrow(/drainSeconds/);
  });

  test('rejects a deregistration delay that outlives the Spot warning', () => {
    expect(withOverrides({ deregistrationDelaySeconds: 300 })).toThrow(/deregistrationDelaySeconds/);
  });

  test('rejects AZ rebalancing with maxHealthyPercent 100', () => {
    expect(withOverrides({ maxHealthyPercent: 100 })).toThrow(/maxHealthyPercent above 100/);
  });

  test('allows maxHealthyPercent 100 once AZ rebalancing is disabled', () => {
    expect(withOverrides({ maxHealthyPercent: 100, availabilityZoneRebalancing: 'DISABLED' })).not.toThrow();
  });

  test('rejects a desired count outside the scaling range', () => {
    expect(withOverrides({ desiredCount: 20 })).toThrow(/desiredCount/);
  });
});

describe('splitByStrategy', () => {
  const strategies = testParams().service.capacityProviderStrategies;

  test.each([
    [2, { FARGATE: 2, FARGATE_SPOT: 0 }],
    [6, { FARGATE: 3, FARGATE_SPOT: 3 }],
    // Observed on ECS when the service was scaled to 9.
    [9, { FARGATE: 4, FARGATE_SPOT: 5 }],
  ])('base 2 / weights 1:3 with %i tasks', (count, expected) => {
    expect(splitByStrategy(strategies, count)).toEqual(expected);
  });

  // Measured on ECS: FARGATE base 1 weight 1 + FARGATE_SPOT weight k, desired raised one task at a time.
  const measured: Record<number, [number, number][]> = {
    3: [[2, 1], [2, 2], [2, 3], [2, 4]],
    6: [[1, 2], [1, 3], [2, 3], [2, 4], [2, 5], [2, 6], [2, 7], [2, 8], [2, 9], [3, 9], [3, 10], [3, 11]],
    11: [[1, 2], [1, 3], [1, 4], [1, 5], [2, 5], [2, 6], [2, 7], [2, 8], [2, 9], [2, 10], [2, 11], [2, 12]],
  };
  test.each(Object.entries(measured))('reproduces the measured splits for base 1, weights 1:%s', (k, rows) => {
    const strategy: CapacityProviderStrategyParams[] = [
      { capacityProvider: 'FARGATE', base: 1, weight: 1 },
      { capacityProvider: 'FARGATE_SPOT', weight: Number(k) },
    ];
    rows.forEach(([onDemand, spot], i) => {
      expect(splitByStrategy(strategy, 3 + i)).toEqual({ FARGATE: onDemand, FARGATE_SPOT: spot });
    });
  });

  test('all-Spot strategy puts every task on FARGATE_SPOT', () => {
    expect(splitByStrategy([{ capacityProvider: 'FARGATE_SPOT', weight: 1 }], 5)).toEqual({ FARGATE: 0, FARGATE_SPOT: 5 });
  });
});

describe('uneven AZ split warning', () => {
  const warnings = (desiredCount: number) =>
    Annotations.fromStack(buildStack({ service: { desiredCount, autoScaling: { minCapacity: 1, maxCapacity: 12, targetCpuUtilizationPercent: 60 } } }))
      .findWarning('*', Match.stringLikeRegexp('tasks per AZ can stay uneven'));

  test('no warning when each provider count is a multiple of the AZ count (6 -> 3/3)', () => {
    expect(warnings(6)).toHaveLength(0);
  });

  test('warns when a provider count is not (9 -> 4/5)', () => {
    expect(warnings(9)).toHaveLength(1);
  });
});
