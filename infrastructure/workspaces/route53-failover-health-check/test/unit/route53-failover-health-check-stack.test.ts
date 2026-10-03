/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { Route53FailoverHealthCheckStack } from 'lib/stacks/route53-failover-health-check-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envParams = params[Environment.TEST];
if (!envParams) {
  throw new Error('No parameters found for test environment');
}

const app = new cdk.App();
const stack = new Route53FailoverHealthCheckStack(app, 'Route53FailoverHealthCheck', {
  project: 'test',
  environment: Environment.TEST,
  isAutoDeleteObject: true,
  env: testEnv,
  params: envParams,
});
const template = Template.fromStack(stack);

describe('Route53FailoverHealthCheckStack', () => {
  describe('endpoints', () => {
    test('two ARM64 Node.js functions with distinct roles, both healthy by default', () => {
      // The third function in the template is the CDK provider that restricts the VPC default security group.
      const endpoints = Object.values(template.findResources('AWS::Lambda::Function', {
        Properties: { Environment: { Variables: { FAIL: 'false' } } },
      }));
      expect(endpoints).toHaveLength(2);
      template.hasResourceProperties('AWS::Lambda::Function', {
        Architectures: ['arm64'],
        Environment: { Variables: { ROLE: 'primary', FAIL: 'false' } },
      });
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: { Variables: { ROLE: 'secondary', FAIL: 'false' } },
      });
    });

    test('each function has a public function URL (health checkers cannot sign requests)', () => {
      template.resourceCountIs('AWS::Lambda::Url', 2);
      template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
    });
  });

  describe('health check', () => {
    test('HTTPS /health with SNI, interval and threshold from parameters', () => {
      template.hasResourceProperties('AWS::Route53::HealthCheck', {
        HealthCheckConfig: Match.objectLike({
          Type: 'HTTPS',
          Port: 443,
          ResourcePath: '/health',
          RequestInterval: envParams.healthCheckIntervalSeconds,
          FailureThreshold: envParams.healthCheckFailureThreshold,
          EnableSNI: true,
        }),
      });
    });
  });

  describe('failover records', () => {
    test('PRIMARY record carries the health check, SECONDARY does not', () => {
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: 'app.failover.internal',
        Type: 'CNAME',
        TTL: String(envParams.recordTtl),
        SetIdentifier: 'primary',
        Failover: 'PRIMARY',
        HealthCheckId: Match.anyValue(),
      });
      const secondary = Object.values(template.findResources('AWS::Route53::RecordSet', {
        Properties: { Failover: 'SECONDARY' },
      })) as any[];
      expect(secondary).toHaveLength(1);
      expect(secondary[0].Properties.HealthCheckId).toBeUndefined();
      expect(secondary[0].Properties.SetIdentifier).toBe('secondary');
    });

    test('records live in a private hosted zone associated with the VPC', () => {
      template.hasResourceProperties('AWS::Route53::HostedZone', {
        Name: 'failover.internal.',
        VPCs: [Match.objectLike({ VPCRegion: 'ap-northeast-1' })],
      });
    });
  });

  describe('resolver probe', () => {
    test('a Lambda in the VPC resolves the record name', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: { Variables: { RECORD_NAME: 'app.failover.internal' } },
        VpcConfig: Match.objectLike({ SubnetIds: [Match.anyValue()] }),
      });
    });
  });

  describe('cost', () => {
    test('the VPC has no NAT gateway', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
    });
  });
});
