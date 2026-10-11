/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { EcsBlueGreenNativeVsCodedeployStack } from 'lib/stacks/ecs-blue-green-native-vs-codedeploy-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envParams = params[Environment.TEST];
if (!envParams) {
  throw new Error('No parameters found for test environment');
}

const build = (allowedIps = ['203.0.113.10']) => {
  const app = new cdk.App();
  const stack = new EcsBlueGreenNativeVsCodedeployStack(app, 'EcsBlueGreenNativeVsCodedeploy', {
    project: 'test',
    environment: Environment.TEST,
    isAutoDeleteObject: true,
    env: testEnv,
    params: envParams,
    allowedIps,
    allowedIpv6s: ['2001:db8::1'],
  });
  return Template.fromStack(stack);
};

describe('EcsBlueGreenNativeVsCodedeployStack', () => {
  const template = build();
  const service = (name: string) => (Object.values(template.findResources('AWS::ECS::Service', { Properties: { ServiceName: name } })) as any[])[0];

  describe('native blue/green', () => {
    test('the service uses the BLUE_GREEN strategy with the configured bake time and the ECS controller', () => {
      const s = service('test-test-bg-native');
      expect(s.Properties.DeploymentConfiguration.Strategy).toBe('BLUE_GREEN');
      expect(s.Properties.DeploymentConfiguration.BakeTimeInMinutes).toBe(envParams.nativeBakeMinutes);
      expect(s.Properties.DeploymentController?.Type ?? 'ECS').toBe('ECS');
    });

    test('the load balancer configuration names a production and a test listener rule and the alternate target group', () => {
      const lb = service('test-test-bg-native').Properties.LoadBalancers[0];
      expect(lb.AdvancedConfiguration).toBeDefined();
      expect(lb.AdvancedConfiguration.AlternateTargetGroupArn).toBeDefined();
      expect(lb.AdvancedConfiguration.ProductionListenerRule).toBeDefined();
      expect(lb.AdvancedConfiguration.TestListenerRule).toBeDefined();
    });

    test('a Lambda lifecycle hook runs after the test traffic shift', () => {
      const hooks = JSON.stringify(service('test-test-bg-native').Properties.DeploymentConfiguration.LifecycleHooks);
      expect(hooks).toContain('POST_TEST_TRAFFIC_SHIFT');
    });

    test('the production and test listeners route through rules so the target groups can be swapped', () => {
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 2);
    });
  });

  describe('CodeDeploy blue/green', () => {
    test('the service hands deployments to CodeDeploy', () => {
      expect(service('test-test-bg-codedeploy').Properties.DeploymentController.Type).toBe('CODE_DEPLOY');
    });

    test('the deployment group shifts all at once, waits before terminating blue, and rolls back on failure and on an alarm', () => {
      template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
        DeploymentGroupName: 'test-test-bg-group',
        DeploymentConfigName: 'CodeDeployDefault.ECSAllAtOnce',
        DeploymentStyle: { DeploymentOption: 'WITH_TRAFFIC_CONTROL', DeploymentType: 'BLUE_GREEN' },
        BlueGreenDeploymentConfiguration: Match.objectLike({
          TerminateBlueInstancesOnDeploymentSuccess: { Action: 'TERMINATE', TerminationWaitTimeInMinutes: envParams.codeDeployTerminationWaitMinutes },
        }),
        AutoRollbackConfiguration: { Enabled: true, Events: Match.arrayWith(['DEPLOYMENT_FAILURE', 'DEPLOYMENT_STOP_ON_ALARM']) },
      });
    });

    test('the deployment group has a test listener and a 5xx alarm', () => {
      const group = Object.values(template.findResources('AWS::CodeDeploy::DeploymentGroup'))[0] as any;
      expect(JSON.stringify(group.Properties.LoadBalancerInfo)).toContain('TargetGroupPairInfoList');
      expect(JSON.stringify(group.Properties.LoadBalancerInfo)).toContain('TestTrafficRoute');
      expect(group.Properties.AlarmConfiguration.Alarms).toHaveLength(1);
    });
  });

  describe('shared', () => {
    test('both services run the same ARM64 task shape in public subnets with a public IP and no NAT gateway', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
      ['test-test-bg-native', 'test-test-bg-codedeploy'].forEach((name) => {
        expect(service(name).Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp).toBe('ENABLED');
        expect(service(name).Properties.DesiredCount).toBe(envParams.desiredCount);
      });
      template.hasResourceProperties('AWS::ECS::TaskDefinition', { Family: 'test-test-bg-native', RuntimePlatform: Match.objectLike({ CpuArchitecture: 'ARM64' }) });
    });

    test('the load balancers admit only the operator on the production and test ports', () => {
      const group = Object.values(template.findResources('AWS::EC2::SecurityGroup', { Properties: { GroupDescription: 'Load balancers: the operator only' } }))[0] as any;
      const ingress = group.Properties.SecurityGroupIngress as any[];
      expect(ingress.every((r) => r.CidrIp === '203.0.113.10/32' || r.CidrIpv6 === '2001:db8::1/128')).toBe(true);
      expect(new Set(ingress.map((r) => r.FromPort))).toEqual(new Set([80, 8080]));
    });

    test('a bare IP becomes a /32 and a CIDR is kept as given', () => {
      const cidr = build(['198.51.100.0/24']);
      const group = Object.values(cidr.findResources('AWS::EC2::SecurityGroup', { Properties: { GroupDescription: 'Load balancers: the operator only' } }))[0] as any;
      expect(group.Properties.SecurityGroupIngress.some((r: any) => r.CidrIp === '198.51.100.0/24')).toBe(true);
    });

    test('each flavor has its own hook verdict parameter, so the two can be driven at the same time', () => {
      template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/test/test/bluegreen/hook-verdict-native', Value: 'pass' });
      template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/test/test/bluegreen/hook-verdict-codedeploy', Value: 'pass' });
    });

    test('the hook function can read only the verdict parameters and report to CodeDeploy', () => {
      const policies = JSON.stringify(Object.values(template.findResources('AWS::IAM::Policy', { Properties: { PolicyName: Match.stringLikeRegexp('^HookFunctionServiceRole') } })));
      expect(policies).toContain('ssm:GetParameter');
      expect(policies).toContain('codedeploy:PutLifecycleEventHookExecutionStatus');
      expect(policies).not.toContain('ecs:');
    });

    test('the container can be made to fail with BREAK to simulate a bad release', () => {
      const td = Object.values(template.findResources('AWS::ECS::TaskDefinition', { Properties: { Family: 'test-test-bg-native' } }))[0] as any;
      const container = td.Properties.ContainerDefinitions[0];
      expect(container.Environment).toEqual(expect.arrayContaining([{ Name: 'BREAK', Value: 'false' }, { Name: 'VERSION', Value: 'v1' }]));
      expect(container.Command[0]).toContain('[ "$BREAK" = "true" ] && exit 1');
    });
  });
});
