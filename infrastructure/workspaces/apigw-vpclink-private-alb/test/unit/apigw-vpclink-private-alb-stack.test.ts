/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { ApigwVpclinkPrivateAlbStack } from 'lib/stacks/apigw-vpclink-private-alb-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envParams = params[Environment.TEST];
if (!envParams) {
  throw new Error('No parameters found for test environment');
}

const app = new cdk.App();
const stack = new ApigwVpclinkPrivateAlbStack(app, 'ApigwVpclinkPrivateAlb', {
  project: 'test',
  environment: Environment.TEST,
  isAutoDeleteObject: true,
  env: testEnv,
  params: envParams,
});
const template = Template.fromStack(stack);

describe('ApigwVpclinkPrivateAlbStack', () => {
  describe('private backend', () => {
    test('ALB is internal and drops invalid headers', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Scheme: 'internal',
        LoadBalancerAttributes: Match.arrayWith([{ Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' }]),
      });
    });

    test('ALB accepts traffic only from the VPC link security group', () => {
      const ingress = template.findResources('AWS::EC2::SecurityGroupIngress', {
        Properties: { FromPort: 80, ToPort: 80, IpProtocol: 'tcp' },
      });
      const sources = Object.values(ingress).map((r: any) => r.Properties.SourceSecurityGroupId?.['Fn::GetAtt']?.[0]);
      expect(sources).toEqual(expect.arrayContaining([expect.stringMatching(/VpcLinkSecurityGroup/), expect.stringMatching(/AlbSecurityGroup/)]));
      const cidrIngress = Object.values(ingress).filter((r: any) => r.Properties.CidrIp);
      expect(cidrIngress).toHaveLength(0);
    });

    test('Fargate tasks run in private subnets without public IPs', () => {
      template.hasResourceProperties('AWS::ECS::Service', {
        LaunchType: 'FARGATE',
        DesiredCount: envParams.desiredCount,
        NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }) },
        DeploymentConfiguration: Match.objectLike({ DeploymentCircuitBreaker: { Enable: true, Rollback: true } }),
      });
    });
  });

  describe('VPC link', () => {
    test('v2 VPC link is placed in the private subnets with its own security group', () => {
      const links = Object.values(template.findResources('AWS::ApiGatewayV2::VpcLink')) as any[];
      expect(links).toHaveLength(1);
      expect(links[0].Properties.SubnetIds).toHaveLength(2);
      expect(links[0].Properties.SecurityGroupIds).toHaveLength(1);
    });

    test('every method integrates through the VPC link with the ALB as the target', () => {
      const methods = template.findResources('AWS::ApiGateway::Method');
      expect(Object.keys(methods)).toHaveLength(2);
      Object.values(methods).forEach((m: any) => {
        expect(m.Properties.Integration).toMatchObject({
          Type: 'HTTP_PROXY',
          ConnectionType: 'VPC_LINK',
          ConnectionId: { 'Fn::GetAtt': [expect.stringMatching(/^VpcLink/), 'VpcLinkId'] },
          IntegrationTarget: { Ref: expect.stringMatching(/^Alb/) },
        });
      });
    });
  });

  describe('API protection', () => {
    test('all methods require an API key', () => {
      const methods = template.findResources('AWS::ApiGateway::Method');
      Object.values(methods).forEach((m: any) => expect(m.Properties.ApiKeyRequired).toBe(true));
    });

    test('usage plan sets throttling and a daily quota', () => {
      template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
        Throttle: { RateLimit: envParams.apiRateLimit, BurstLimit: envParams.apiBurstLimit },
        Quota: { Limit: envParams.apiDailyQuota, Period: 'DAY' },
      });
    });

    test('stage has access logs and throttling', () => {
      template.hasResourceProperties('AWS::ApiGateway::Stage', {
        StageName: 'v1',
        AccessLogSetting: Match.objectLike({ DestinationArn: Match.anyValue() }),
        MethodSettings: Match.arrayWith([
          Match.objectLike({ ThrottlingRateLimit: envParams.apiRateLimit, ThrottlingBurstLimit: envParams.apiBurstLimit }),
        ]),
      });
    });
  });

  describe('network', () => {
    test('VPC has no internet-facing resources other than the NAT gateway', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', envParams.natGateways);
    });
  });
});
