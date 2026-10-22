import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildMainStack, cloudFrontWebAclArn } from '../helpers/stack';

describe('WafPhp2ShellMitigationStack', () => {
  const template = Template.fromStack(buildMainStack());

  describe('ALB Web ACL', () => {
    test('is REGIONAL, allows by default and has no rate rule (it only sees CloudFront edge IPs)', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Scope: 'REGIONAL',
        DefaultAction: { Allow: {} },
        AssociationConfig: Match.absent(),
        Rules: Match.not(Match.arrayWith([Match.objectLike({ Name: 'RateLimit-Posts' })])),
      });
      template.resourceCountIs('AWS::WAFv2::IPSet', 0);
    });

    test('labels its responses with the alb layer', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'PHP2Shell',
            Action: {
              Block: {
                CustomResponse: Match.objectLike({
                  ResponseHeaders: [{ Name: 'x-php2shell-blocked-by', Value: 'alb:PHP2Shell' }],
                }),
              },
            },
          }),
        ]),
      });
    });

    test('is associated with the ALB', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACLAssociation', {
        ResourceArn: { Ref: Match.stringLikeRegexp('Alb') },
      });
    });
  });

  describe('ALB access control', () => {
    test('security group admits the CloudFront origin-facing prefix list and the verification IP', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        SourcePrefixListId: 'pl-58a04531',
        FromPort: 80,
        ToPort: 80,
      });
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: [Match.objectLike({ CidrIp: '203.0.113.10/32', FromPort: 80, ToPort: 80 })],
      });
    });

    test('listener rejects by default and forwards on the origin verify header', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 80,
        DefaultActions: [Match.objectLike({ Type: 'fixed-response', FixedResponseConfig: Match.objectLike({ StatusCode: '403' }) })],
      });
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
        Priority: 10,
        Conditions: [Match.objectLike({ Field: 'http-header', HttpHeaderConfig: Match.objectLike({ HttpHeaderName: 'X-Origin-Verify' }) })],
      });
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
        Priority: 20,
        Conditions: [Match.objectLike({ Field: 'source-ip', SourceIpConfig: { Values: ['203.0.113.10/32'] } })],
      });
    });

    test('closes the direct path when no verification IP is given', () => {
      const closed = Template.fromStack(buildMainStack(undefined, { directAccessIps: undefined }));
      closed.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 1);
      closed.hasResourceProperties('AWS::EC2::SecurityGroup', { SecurityGroupIngress: Match.absent() });
      closed.resourceCountIs('AWS::EC2::SecurityGroupIngress', 1);
    });
  });

  describe('Origin', () => {
    test('runs the PHP container image on x86_64', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        PackageType: 'Image',
        Architectures: ['x86_64'],
        MemorySize: 1024,
        Timeout: 30,
      });
    });

    test('is the Lambda target of the ALB', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { TargetType: 'lambda' });
    });

    test('VPC has public subnets only and no NAT gateway', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
      template.resourceCountIs('AWS::EC2::Subnet', 2);
    });
  });

  describe('CloudFront', () => {
    test('uses the us-east-1 Web ACL and sends the origin verify header over HTTP to the ALB', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          WebACLId: cloudFrontWebAclArn,
          Origins: [
            Match.objectLike({
              CustomOriginConfig: Match.objectLike({ OriginProtocolPolicy: 'http-only' }),
              OriginCustomHeaders: [Match.objectLike({ HeaderName: 'X-Origin-Verify' })],
            }),
          ],
        }),
      });
    });

    test('disables caching, forwards all viewer headers and allows POST', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            AllowedMethods: Match.arrayWith(['PUT', 'POST']),
            CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
            OriginRequestPolicyId: '216adef6-5c7f-47e4-b989-5492eafa07d3',
            ViewerProtocolPolicy: 'redirect-to-https',
          }),
        }),
      });
    });
  });
});
