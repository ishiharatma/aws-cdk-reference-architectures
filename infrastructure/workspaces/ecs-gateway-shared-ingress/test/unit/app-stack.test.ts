import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildStacks } from '../helpers/stack';

describe('AppStack', () => {
  const template = Template.fromStack(buildStacks().app);

  const serviceNamed = (name: string) => {
    const services = template.findResources('AWS::ECS::Service', { Properties: { ServiceName: `test-test-ecsgw-${name}` } });
    const values = Object.values(services);
    expect(values).toHaveLength(1);
    return values[0].Properties;
  };

  describe('gateway connectors', () => {
    test('every service has exactly one connector on the named port', () => {
      template.resourceCountIs('AWS::ECS::Service', 3);
      template.allResourcesProperties('AWS::ECS::Service', {
        GatewayConnectors: [Match.objectLike({ PortName: 'web' })],
      });
    });

    test('public services filter on PUBLIC and the internal one on PRIVATE', () => {
      expect(serviceNamed('web').GatewayConnectors[0].Filters).toEqual({ AccessTypes: ['PUBLIC'] });
      expect(serviceNamed('orders').GatewayConnectors[0].Filters).toEqual({ AccessTypes: ['PUBLIC'] });
      expect(serviceNamed('internal-api').GatewayConnectors[0].Filters).toEqual({ AccessTypes: ['PRIVATE'] });
    });

    test('omits the filter when a service accepts every access type', () => {
      const t = Template.fromStack(
        buildStacks({ appParams: { services: [{ name: 'any', desiredCount: 1, deploymentStrategy: 'ROLLING' }] } }).app,
      );
      t.hasResourceProperties('AWS::ECS::Service', {
        GatewayConnectors: [Match.objectLike({ PortName: 'web', Filters: Match.absent() })],
      });
    });

    test('sets the health check at creation (ROLLING services cannot change it later)', () => {
      template.allResourcesProperties('AWS::ECS::Service', {
        GatewayConnectors: [
          Match.objectLike({
            HealthCheck: Match.objectLike({ HealthCheckPath: '/', HealthCheckIntervalSeconds: 10, Matcher: { HttpCode: '200' } }),
          }),
        ],
      });
    });

    test('services declare no load balancer of their own', () => {
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 0);
      for (const service of Object.values(template.findResources('AWS::ECS::Service'))) {
        expect(service.Properties.LoadBalancers ?? []).toHaveLength(0);
      }
    });
  });

  describe('task definitions', () => {
    test('container exposes the named port the connector refers to (awsvpc)', () => {
      template.allResourcesProperties('AWS::ECS::TaskDefinition', {
        NetworkMode: 'awsvpc',
        ContainerDefinitions: [
          Match.objectLike({ PortMappings: [Match.objectLike({ Name: 'web', ContainerPort: 80, AppProtocol: 'http' })] }),
        ],
      });
    });

    test('response echoes the test traffic header', () => {
      const taskDefs = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
      for (const td of taskDefs) {
        expect(td.Properties.ContainerDefinitions[0].Command[0]).toContain('"testHeader":"\\$http_x_test_traffic"');
      }
    });
  });

  describe('deployment strategies', () => {
    test('web uses CANARY with the configured step and bake times', () => {
      expect(serviceNamed('web').DeploymentConfiguration).toMatchObject({
        Strategy: 'CANARY',
        CanaryConfiguration: { CanaryPercent: 10, CanaryBakeTimeInMinutes: 5 },
        BakeTimeInMinutes: 1,
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      });
    });

    test('the other services use ROLLING and keep full capacity during deployments', () => {
      for (const name of ['orders', 'internal-api']) {
        expect(serviceNamed(name).DeploymentConfiguration).toMatchObject({ Strategy: 'ROLLING', MinimumHealthyPercent: 100 });
      }
    });
  });

  describe('network placement', () => {
    test('tasks run in private subnets without public IPs', () => {
      template.allResourcesProperties('AWS::ECS::Service', {
        NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }) },
      });
    });

    test('task security groups have no inbound rules (ECS manages ingress from the gateway ALB)', () => {
      const groups = template.findResources('AWS::EC2::SecurityGroup', {
        Properties: { GroupDescription: Match.stringLikeRegexp('ingress is managed by the ECS gateway') },
      });
      expect(Object.keys(groups)).toHaveLength(3);
      for (const group of Object.values(groups)) {
        expect(group.Properties.SecurityGroupIngress).toBeUndefined();
      }
      template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    });
  });

  describe('probe function', () => {
    test('runs in the VPC to reach internal gateway hostnames', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-test-ecsgw-probe',
        Runtime: 'nodejs24.x',
        VpcConfig: Match.objectLike({ SubnetIds: Match.anyValue() }),
      });
    });
  });
});
