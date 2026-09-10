import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { BaseStack } from 'lib/stacks/base-stack';
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

describe('BaseStack Unit Tests', () => {
  let template: Template;

  beforeAll(() => {
    const context = { ...baseContext, 'aws:cdk:bundling-stacks': [] };
    const app = new cdk.App({ context });
    const stack = new BaseStack(app, 'Base', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      vpcConfig: envParams.vpcConfig,
      allowedIpsforAlb: ['10.0.0.0/8'],
    });
    template = Template.fromStack(stack);
  });

  describe('VPC', () => {
    test('creates exactly one VPC', () => {
      template.resourceCountIs('AWS::EC2::VPC', 1);
    });

    test('creates one internet gateway', () => {
      template.resourceCountIs('AWS::EC2::InternetGateway', 1);
    });
  });

  describe('Security Groups — topology', () => {
    test('creates 5 named security groups plus NAT instance SG (6 total)', () => {
      // 5 named SGs: keycloakAlb, appAlb, keycloakEcs, appEcs, db
      // + 1 auto-created by VpcConstruct for the NAT instance
      template.resourceCountIs('AWS::EC2::SecurityGroup', 6);
    });

    test('keycloakAlbSg allows HTTP/80 ingress from specified CIDR', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Keycloak ALB - inbound HTTP/HTTPS',
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({ IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '10.0.0.0/8' }),
        ]),
      });
    });

    test('keycloakAlbSg allows HTTPS/443 ingress from specified CIDR', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Keycloak ALB - inbound HTTP/HTTPS',
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '10.0.0.0/8' }),
        ]),
      });
    });

    test('keycloakEcsSg allows port 8080 ingress from Keycloak ALB SG', () => {
      // Same-stack SG-to-SG rules are inlined in the SecurityGroup resource
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Keycloak ECS tasks',
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({ IpProtocol: 'tcp', FromPort: 8080, ToPort: 8080 }),
        ]),
      });
    });

    test('appEcsSg allows port 80 ingress from App ALB SG', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'App ECS tasks',
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({ IpProtocol: 'tcp', FromPort: 80, ToPort: 80 }),
        ]),
      });
    });

    test('dbSg allows port 5432 ingress from Keycloak ECS SG', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Aurora PostgreSQL - inbound from Keycloak ECS',
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({ IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432 }),
        ]),
      });
    });

    test('dbSg has allowAllOutbound=false (CDK sentinel egress rule present)', () => {
      // When allowAllOutbound=false, CDK synthesizes a sentinel rule:
      //   IpProtocol: "icmp", CidrIp: "255.255.255.255/32" — blocks all outbound.
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Aurora PostgreSQL - inbound from Keycloak ECS',
        SecurityGroupEgress: Match.arrayWith([
          Match.objectLike({ CidrIp: '255.255.255.255/32' }),
        ]),
      });
    });
  });
});
