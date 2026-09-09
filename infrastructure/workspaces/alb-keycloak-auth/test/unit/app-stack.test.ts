import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { BaseStack } from 'lib/stacks/base-stack';
import { AppStack } from 'lib/stacks/app-stack';
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

describe('AppStack Unit Tests', () => {
  describe('OIDC disabled (default / initial setup mode)', () => {
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
      const stack = new AppStack(app, 'App', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        vpc: baseStack.vpcConstruct.vpc,
        albSg: baseStack.appAlbSg,
        appEcsSg: baseStack.appEcsSg,
        oidcConfig: { ...envParams.oidcConfig, enabled: false },
        keycloakBaseUrl: 'http://keycloak.example.com',
        keycloakRealmName: envParams.keycloakConfig.realmName,
        isAlbOpen: true,
      });
      template = Template.fromStack(stack);
    });

    test('creates one internet-facing ALB', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Scheme: 'internet-facing',
        Type: 'application',
      });
    });

    test('HTTP listener on port 80 with forward action (no OIDC)', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 80,
        Protocol: 'HTTP',
        DefaultActions: Match.arrayWith([
          Match.objectLike({ Type: 'forward' }),
        ]),
      });
    });

    test('creates one listener only (no HTTPS when OIDC disabled)', () => {
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
    });

    test('target group uses port 80 (nginx)', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Port: 80,
        Protocol: 'HTTP',
        TargetType: 'ip',
      });
    });
  });

  describe('ECS Fargate — nginx app', () => {
    let template: Template;

    beforeAll(() => {
      const context = { ...baseContext, 'aws:cdk:bundling-stacks': [] };
      const app = new cdk.App({ context });
      const baseStack = new BaseStack(app, 'Base2', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        vpcConfig: envParams.vpcConfig,
      });
      const stack = new AppStack(app, 'App2', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        vpc: baseStack.vpcConstruct.vpc,
        albSg: baseStack.appAlbSg,
        appEcsSg: baseStack.appEcsSg,
        oidcConfig: { ...envParams.oidcConfig, enabled: false },
        keycloakBaseUrl: 'http://keycloak.example.com',
        keycloakRealmName: envParams.keycloakConfig.realmName,
        isAlbOpen: true,
      });
      template = Template.fromStack(stack);
    });

    test('creates ECS cluster', () => {
      template.hasResourceProperties('AWS::ECS::Cluster', {
        ClusterName: `${projectName}-${envName}-app`,
      });
    });

    test('Fargate task definition: 256 CPU, 512 MB', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Cpu: '256',
        Memory: '512',
        RequiresCompatibilities: ['FARGATE'],
      });
    });

    test('container uses nginx image', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Image: Match.stringLikeRegexp('nginx'),
          }),
        ]),
      });
    });

    test('ECS service has ECS Exec enabled', () => {
      template.hasResourceProperties('AWS::ECS::Service', {
        EnableExecuteCommand: true,
      });
    });
  });

  describe('Secrets Manager', () => {
    let template: Template;

    beforeAll(() => {
      const context = { ...baseContext, 'aws:cdk:bundling-stacks': [] };
      const app = new cdk.App({ context });
      const baseStack = new BaseStack(app, 'Base3', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        vpcConfig: envParams.vpcConfig,
      });
      const stack = new AppStack(app, 'App3', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        vpc: baseStack.vpcConstruct.vpc,
        albSg: baseStack.appAlbSg,
        appEcsSg: baseStack.appEcsSg,
        oidcConfig: envParams.oidcConfig,
        keycloakBaseUrl: 'http://keycloak.example.com',
        keycloakRealmName: envParams.keycloakConfig.realmName,
        isAlbOpen: true,
      });
      template = Template.fromStack(stack);
    });

    test('creates OIDC client secret placeholder', () => {
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: `/${projectName}/${envName}/keycloak/oidc-client`,
      });
    });
  });

  describe('Error handling', () => {
    test('throws when OIDC enabled but no domain provided', () => {
      const context = { ...baseContext, 'aws:cdk:bundling-stacks': [] };
      const app = new cdk.App({ context });
      const baseStack = new BaseStack(app, 'BaseErr', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        vpcConfig: envParams.vpcConfig,
      });
      expect(() => {
        new AppStack(app, 'AppErr', {
          project: projectName,
          environment: envName,
          env: defaultEnv,
          isAutoDeleteObject: true,
          vpc: baseStack.vpcConstruct.vpc,
          albSg: baseStack.appAlbSg,
          appEcsSg: baseStack.appEcsSg,
          oidcConfig: { ...envParams.oidcConfig, enabled: true },
          keycloakBaseUrl: 'http://keycloak.example.com',
          keycloakRealmName: envParams.keycloakConfig.realmName,
          isAlbOpen: true,
          // domainName intentionally omitted
        });
      }).toThrow('OIDC authentication requires HTTPS');
    });
  });
});
