import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildStacks, clientIp, testParams } from '../helpers/stack';

describe('PlatformStack', () => {
  const template = Template.fromStack(buildStacks().platform);

  describe('gateways', () => {
    test('creates one internet-facing and one internal HostSharedAlb gateway', () => {
      template.resourceCountIs('AWS::ECS::Gateway', 2);
      template.hasResourceProperties('AWS::ECS::Gateway', {
        GatewayName: 'test-test-ecsgw-public',
        Configuration: { HostSharedAlb: Match.objectLike({ Scheme: 'internet-facing' }) },
      });
      template.hasResourceProperties('AWS::ECS::Gateway', {
        GatewayName: 'test-test-ecsgw-private',
        Configuration: { HostSharedAlb: Match.objectLike({ Scheme: 'internal' }) },
      });
    });

    test('places each gateway in the subnets of its tier (both AZs)', () => {
      template.hasResourceProperties('AWS::ECS::Gateway', {
        GatewayName: 'test-test-ecsgw-public',
        Configuration: {
          HostSharedAlb: Match.objectLike({
            NetworkConfiguration: Match.objectLike({
              Subnets: [{ Ref: Match.stringLikeRegexp('publicSubnet1') }, { Ref: Match.stringLikeRegexp('publicSubnet2') }],
            }),
          }),
        },
      });
      template.hasResourceProperties('AWS::ECS::Gateway', {
        GatewayName: 'test-test-ecsgw-private',
        Configuration: {
          HostSharedAlb: Match.objectLike({
            NetworkConfiguration: Match.objectLike({
              Subnets: [{ Ref: Match.stringLikeRegexp('privateSubnet1') }, { Ref: Match.stringLikeRegexp('privateSubnet2') }],
            }),
          }),
        },
      });
    });

    test('disables deletion protection so that cdk destroy can remove the gateway', () => {
      template.allResourcesProperties('AWS::ECS::Gateway', { DeletionProtection: false });
    });

    test('does not propagate tags (ACM rejects the aws:cloudformation:* tags of the gateway)', () => {
      template.allResourcesProperties('AWS::ECS::Gateway', { PropagateTags: 'NONE' });
    });

    test('applies the same test traffic header to both gateways', () => {
      const { name, values } = testParams().platform.testTrafficHeader;
      template.allResourcesProperties('AWS::ECS::Gateway', {
        Configuration: { HostSharedAlb: Match.objectLike({ TestTrafficRules: { Header: { Name: name, Values: values } } }) },
      });
    });

    test('public gateway carries the WAF Web ACL, access logs and own inbound security group', () => {
      template.hasResourceProperties('AWS::ECS::Gateway', {
        GatewayName: 'test-test-ecsgw-public',
        Configuration: {
          HostSharedAlb: Match.objectLike({
            WebACLArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('PublicGatewayWebAcl'), 'Arn'] },
            AccessLogs: { Destination: { S3: { Bucket: { Ref: Match.stringLikeRegexp('AlbAccessLogBucket') }, Prefix: 'gateway-public' } } },
            NetworkConfiguration: Match.objectLike({
              InboundSecurityGroup: { 'Fn::GetAtt': [Match.stringLikeRegexp('PublicGatewayInboundSecurityGroup'), 'GroupId'] },
            }),
          }),
        },
      });
    });

    test('private gateway has no WAF, access logs or inbound security group', () => {
      template.hasResourceProperties('AWS::ECS::Gateway', {
        GatewayName: 'test-test-ecsgw-private',
        Configuration: {
          HostSharedAlb: Match.objectLike({
            WebACLArn: Match.absent(),
            AccessLogs: Match.absent(),
            NetworkConfiguration: Match.objectLike({ InboundSecurityGroup: Match.absent() }),
          }),
        },
      });
    });

    test('omits the inbound security group when the restriction is off', () => {
      const base = testParams().platform;
      const t = Template.fromStack(
        buildStacks({ platform: { publicGateway: { ...base.publicGateway, restrictIngressToAllowedIps: false } } }).platform,
      );
      t.resourceCountIs('AWS::ECS::Gateway', 2);
      t.allResourcesProperties('AWS::ECS::Gateway', {
        Configuration: { HostSharedAlb: Match.objectLike({ NetworkConfiguration: Match.objectLike({ InboundSecurityGroup: Match.absent() }) }) },
      });
    });
  });

  describe('cluster associations', () => {
    test('associates both gateways with the cluster', () => {
      template.resourceCountIs('AWS::ECS::GatewayClusterAssociations', 2);
      template.allResourcesProperties('AWS::ECS::GatewayClusterAssociations', {
        Cluster: { 'Fn::GetAtt': [Match.stringLikeRegexp('Cluster'), 'Arn'] },
        Gateway: { 'Fn::GetAtt': [Match.stringLikeRegexp('Gateway'), 'Arn'] },
      });
    });
  });

  describe('infrastructure role', () => {
    test('is assumable by ECS and uses the HostSharedALB managed policy', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [Match.objectLike({ Principal: { Service: 'ecs.amazonaws.com' }, Action: 'sts:AssumeRole' })],
        },
        ManagedPolicyArns: [
          { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/AmazonECSInfrastructureRoleForGatewayHostSharedALB']] },
        ],
      });
    });

    test('is created before the gateways', () => {
      const gateways = template.findResources('AWS::ECS::Gateway');
      for (const gateway of Object.values(gateways)) {
        expect(gateway.DependsOn).toEqual(expect.arrayContaining([expect.stringMatching(/^GatewayInfrastructureRole/)]));
      }
    });
  });

  describe('public gateway guard rails', () => {
    test('inbound security group allows HTTPS from the client IP only', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Public gateway ALBs: HTTPS from the allowed client IPs only',
        SecurityGroupIngress: [{ CidrIp: `${clientIp}/32`, FromPort: 443, ToPort: 443, IpProtocol: 'tcp', Description: `client ${clientIp}` }],
      });
    });

    test('Web ACL is regional with managed rule groups and a rate rule', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Scope: 'REGIONAL',
        DefaultAction: { Allow: {} },
        Rules: Match.arrayWith([
          Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet' }),
          Match.objectLike({ Name: 'AWSManagedRulesKnownBadInputsRuleSet' }),
          Match.objectLike({
            Name: 'RateLimitPerIp',
            Statement: { RateBasedStatement: { Limit: testParams().platform.publicGateway.wafRateLimit, AggregateKeyType: 'IP' } },
          }),
        ]),
      });
    });

    test('access log bucket uses SSE-S3 and lets Elastic Load Balancing write logs', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
      });
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({ Action: 's3:PutObject', Principal: { Service: 'logdelivery.elasticloadbalancing.amazonaws.com' } }),
            // ap-northeast-1 predates the service principal and delivers through the regional ELB account.
            Match.objectLike({ Action: 's3:PutObject', Principal: { AWS: Match.anyValue() } }),
          ]),
        },
      });
    });
  });

  describe('network', () => {
    test('has public and private subnets in two AZs with one NAT gateway', () => {
      template.resourceCountIs('AWS::EC2::Subnet', 4);
      template.resourceCountIs('AWS::EC2::NatGateway', 1);
    });

    test('cluster enables Container Insights', () => {
      template.hasResourceProperties('AWS::ECS::Cluster', {
        ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }],
      });
    });
  });
});
