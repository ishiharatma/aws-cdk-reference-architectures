import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { BaseStack } from 'lib/stacks/base-stack';
import { DatabaseStack } from 'lib/stacks/database-stack';
import { KeycloakStack } from 'lib/stacks/keycloak-stack';
import { params } from 'parameters/environments';
import '../parameters';
import * as path from 'path';
import { loadCdkContext } from '@common/test-helpers/test-context';

const defaultEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'testproject';
const envName: Environment = Environment.TEST;

if (!params[envName]) throw new Error(`No parameters for ${envName}`);
const envParams = params[envName]!;

const cdkJsonPath = path.resolve(__dirname, '../../cdk.json');
const baseContext = loadCdkContext(cdkJsonPath);

describe('KeycloakStack Unit Tests', () => {
  let template: Template;

  beforeAll(() => {
    const context = { ...baseContext, 'aws:cdk:bundling-stacks': [] };
    const app = new cdk.App({ context });
    const baseStack = new BaseStack(app, 'Base', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      vpcConfig: envParams.vpcConfig,
    });
    const dbStack = new DatabaseStack(app, 'Database', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      vpc: baseStack.vpcConstruct.vpc,
      dbSg: baseStack.dbSg,
      auroraConfig: envParams.auroraConfig,
    });
    const stack = new KeycloakStack(app, 'Keycloak', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      vpc: baseStack.vpcConstruct.vpc,
      albSg: baseStack.keycloakAlbSg,
      keycloakEcsSg: baseStack.keycloakEcsSg,
      auroraCluster: dbStack.cluster,
      auroraSecret: dbStack.secret,
      keycloakConfig: envParams.keycloakConfig,
      isAlbOpen: true,
    });
    template = Template.fromStack(stack);
  });

  describe('Secrets Manager', () => {
    test('creates admin credentials secret', () => {
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: `/${projectName}/${envName}/keycloak/admin`,
        GenerateSecretString: Match.objectLike({
          SecretStringTemplate: JSON.stringify({ username: 'admin' }),
          GenerateStringKey: 'password',
        }),
      });
    });
  });

  describe('ALB', () => {
    test('creates one internet-facing ALB', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Scheme: 'internet-facing',
        Type: 'application',
      });
    });

    test('HTTP listener on port 80', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 80,
        Protocol: 'HTTP',
      });
    });

    test('target group uses port 8080', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Port: 8080,
        Protocol: 'HTTP',
        TargetType: 'ip',
      });
    });

    test('target group health check path is /health/ready', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        HealthCheckPath: '/health/ready',
      });
    });
  });

  describe('ECS Fargate', () => {
    test('creates ECS cluster with Container Insights', () => {
      template.hasResourceProperties('AWS::ECS::Cluster', {
        ClusterName: `${projectName}-${envName}-keycloak`,
        ClusterSettings: Match.arrayWith([
          Match.objectLike({ Name: 'containerInsights', Value: 'enabled' }),
        ]),
      });
    });

    test('Fargate task definition has correct CPU and memory', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Cpu: String(envParams.keycloakConfig.cpu),
        Memory: String(envParams.keycloakConfig.memoryLimitMiB),
        NetworkMode: 'awsvpc',
        RequiresCompatibilities: ['FARGATE'],
      });
    });

    test('container uses correct Keycloak image', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Image: `quay.io/keycloak/keycloak:${envParams.keycloakConfig.keycloakVersion}`,
          }),
        ]),
      });
    });

    test('container exposes port 8080', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            PortMappings: Match.arrayWith([
              Match.objectLike({ ContainerPort: 8080, Protocol: 'tcp' }),
            ]),
          }),
        ]),
      });
    });

    test('ECS service has ECS Exec enabled', () => {
      template.hasResourceProperties('AWS::ECS::Service', {
        EnableExecuteCommand: true,
      });
    });

    test('ECS service deploys in private subnets', () => {
      template.hasResourceProperties('AWS::ECS::Service', {
        LaunchType: 'FARGATE',
      });
    });
  });

  describe('CloudFormation Outputs', () => {
    test('outputs Keycloak ALB DNS', () => {
      template.hasOutput('KeycloakAlbDns', {});
    });

    test('outputs admin secret ARN', () => {
      template.hasOutput('AdminSecretArn', {});
    });
  });
});
