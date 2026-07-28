import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { CloudfrontVpcOriginStack } from 'lib/stacks/cloudfront-vpc-origin-stack';
import { params, PublicAlbFailoverConfig } from 'parameters/environments';
import '../parameters';

const defaultEnv = {
  account: '123456789012',
  region: 'ap-northeast-1',
};

const projectName = 'test-project';
const envName: Environment = Environment.TEST;

if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

interface BuildStackOptions {
  readonly allowedCloudFunctionIps?: string[];
  readonly cloudfrontManagedPrefixList?: string;
  readonly publicAlbFailover?: PublicAlbFailoverConfig;
}

function buildStack(options: BuildStackOptions = {}) {
  const app = new cdk.App();
  const stack = new CloudfrontVpcOriginStack(app, 'CloudfrontVpcOriginStack', {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    terminationProtection: false,
    vpcConfig: envParams.vpcConfig,
    allowedCloudFunctionIps: options.allowedCloudFunctionIps,
    cloudfrontManagedPrefixList: options.cloudfrontManagedPrefixList,
    publicAlbFailover: options.publicAlbFailover,
  });
  return Template.fromStack(stack);
}

describe('CloudfrontVpcOriginStack', () => {
  const template = buildStack({ allowedCloudFunctionIps: ['192.0.2.10'] });

  test('ALB is internal, not internet-facing', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internal',
      Type: 'application',
    });
  });

  test('ALB security group only allows inbound from within the VPC on port 80', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          FromPort: 80,
          ToPort: 80,
          IpProtocol: 'tcp',
          CidrIp: Match.objectLike({ 'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('^Vpc')]) }),
        }),
      ]),
    });
  });

  test('ALB listener rules for /alb/custom* and /alb/lambda* have explicit priorities', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 10,
      Conditions: Match.arrayWith([
        Match.objectLike({
          Field: 'path-pattern',
          PathPatternConfig: { Values: ['/alb/custom*'] },
        }),
      ]),
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 20,
      Conditions: Match.arrayWith([
        Match.objectLike({
          Field: 'path-pattern',
          PathPatternConfig: { Values: ['/alb/lambda*'] },
        }),
      ]),
    });
  });

  test('Lambda target behind the ALB uses the Node.js 24 runtime', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Handler: 'index.handler',
    });
  });

  test('website and error buckets enforce SSL-only access', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    const targetBucketNames = [
      `${projectName}-${envName}-website-bucket`,
      `${projectName}-${envName}-error-bucket`,
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const targetLogicalIds = Object.entries(buckets)
      .filter(([, res]: [string, any]) => targetBucketNames.includes(res.Properties?.BucketName))
      .map(([id]) => id);
    expect(targetLogicalIds).toHaveLength(2);

    const policies = template.findResources('AWS::S3::BucketPolicy');
    targetLogicalIds.forEach((bucketId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matchingPolicy = Object.values(policies).find((policy: any) =>
        JSON.stringify(policy.Properties.PolicyDocument.Statement).includes(bucketId)
      );
      expect(matchingPolicy).toBeDefined();
      expect(matchingPolicy!.Properties.PolicyDocument.Statement).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ])
      );
    });
  });

  test('static site content is deployed to both S3 buckets', () => {
    template.resourceCountIs('Custom::CDKBucketDeployment', 2);
  });

  test('CloudFront has a default (S3) behavior and a dedicated /alb/* behavior', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/alb/*',
            ViewerProtocolPolicy: 'redirect-to-https',
          }),
        ]),
      }),
    });
  });

  test('/alb/* behavior targets an origin group that fails over from the ALB to the S3 error bucket', () => {
    const distributions = template.findResources('AWS::CloudFront::Distribution');
    const config = Object.values(distributions)[0].Properties.DistributionConfig;

    const originGroup = config.OriginGroups.Items[0];
    expect(originGroup.FailoverCriteria.StatusCodes).toEqual({
      Items: [403, 404, 500, 502, 503, 504],
      Quantity: 6,
    });
    expect(originGroup.Members.Items).toHaveLength(2);

    // the /alb/* behavior's TargetOriginId must point at the origin group, not the raw ALB origin
    const albBehavior = config.CacheBehaviors.find((b: { PathPattern: string }) => b.PathPattern === '/alb/*');
    expect(albBehavior.TargetOriginId).toEqual(originGroup.Id);
  });

  test('/alb/* behavior has caching disabled, so a stale response can never mask an origin/failover change', () => {
    const distributions = template.findResources('AWS::CloudFront::Distribution');
    const config = Object.values(distributions)[0].Properties.DistributionConfig;
    const albBehavior = config.CacheBehaviors.find((b: { PathPattern: string }) => b.PathPattern === '/alb/*');
    // Managed "CachingDisabled" policy ID — see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html
    expect(albBehavior.CachePolicyId).toEqual('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
  });

  test('CloudFront connects to the ALB through a VPC origin', () => {
    template.resourceCountIs('AWS::CloudFront::VpcOrigin', 1);
  });

  test('exposes distribution domain name, ID and URL as outputs', () => {
    template.hasOutput('CloudFrontDistributionDomainName', {});
    template.hasOutput('CloudFrontDistributionId', {});
    template.hasOutput('CloudFrontURL', {});
  });

  describe('when allowedCloudFunctionIps is not provided', () => {
    const templateWithoutAllowlist = buildStack({});

    test('no CloudFront Function / IP allowlist is created', () => {
      templateWithoutAllowlist.resourceCountIs('AWS::CloudFront::Function', 0);
    });
  });

  describe('when allowedCloudFunctionIps is provided', () => {
    test('a CloudFront Function denies non-allowed viewer IPs', () => {
      template.resourceCountIs('AWS::CloudFront::Function', 1);
      template.hasResourceProperties('AWS::CloudFront::Function', {
        FunctionCode: Match.stringLikeRegexp('192\\.0\\.2\\.10'),
      });
    });
  });

  describe('when publicAlbFailover is not provided (default)', () => {
    test('ALB stays internal and the VPC Origin is the primary origin', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Scheme: 'internal',
      });
    });
  });

  describe('when publicAlbFailover.enabled is true', () => {
    test('requires cloudfrontManagedPrefixList to be set', () => {
      expect(() => buildStack({ publicAlbFailover: { enabled: true } })).toThrow(
        /requires cloudfrontManagedPrefixList/
      );
    });

    const failoverTemplate = buildStack({
      cloudfrontManagedPrefixList: 'pl-00000000',
      publicAlbFailover: { enabled: true },
    });

    test('ALB becomes internet-facing', () => {
      failoverTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Scheme: 'internet-facing',
        Type: 'application',
      });
    });

    test('ALB security group still only allows inbound from the CloudFront managed prefix list, never the open internet', () => {
      const inlineIngress = Object.values(failoverTemplate.findResources('AWS::EC2::SecurityGroup'))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .flatMap((g: any) => g.Properties?.SecurityGroupIngress ?? []);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(inlineIngress.some((rule: any) => rule.CidrIp === '0.0.0.0/0')).toBe(false);

      failoverTemplate.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        FromPort: 80,
        ToPort: 80,
        IpProtocol: 'tcp',
        SourcePrefixListId: 'pl-00000000',
      });
      // The internal ALB's port-80 rule (VPC Origin path, kept regardless of publicAlbFailover)
      // plus the now-internet-facing public ALB's port-80 rule — both scoped to the CloudFront
      // managed prefix list, neither open to 0.0.0.0/0 (checked above).
      failoverTemplate.resourceCountIs('AWS::EC2::SecurityGroupIngress', 2);
    });

    test('while enabled, the origin group falls back to the S3 error page, and the VPC Origin is not kept around', () => {
      // Accepted trade-off of this escape hatch (see the stack's comments): the VPC Origin isn't
      // kept bound while publicAlbFailover is enabled, so it doesn't exist in this state and gets
      // recreated (~15 min) when reverting to normal mode — not an instant, zero-recreation switch.
      failoverTemplate.resourceCountIs('AWS::CloudFront::VpcOrigin', 0);

      const distributions = failoverTemplate.findResources('AWS::CloudFront::Distribution');
      const config = Object.values(distributions)[0].Properties.DistributionConfig;
      const originGroup = config.OriginGroups.Items[0];
      expect(originGroup.Members.Items).toHaveLength(2);
    });

    test('the public ALB origin sends a secret custom header, and the listener rejects requests without it', () => {
      const distributions = failoverTemplate.findResources('AWS::CloudFront::Distribution');
      const config = Object.values(distributions)[0].Properties.DistributionConfig;
      const originGroup = config.OriginGroups.Items[0];
      const publicOriginId = originGroup.Members.Items[0].OriginId;
      const publicOrigin = config.Origins.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (origin: any) => origin.Id === publicOriginId
      );
      expect(publicOrigin.OriginCustomHeaders).toEqual([
        { HeaderName: 'X-Origin-Verify', HeaderValue: expect.any(String) },
      ]);
      const secret = publicOrigin.OriginCustomHeaders[0].HeaderValue;
      expect(secret.length).toBeGreaterThanOrEqual(32);

      // Default action (no matching header-gated rule) rejects the request.
      failoverTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        DefaultActions: Match.arrayWith([
          Match.objectLike({
            FixedResponseConfig: Match.objectLike({ StatusCode: '403' }),
          }),
        ]),
      });

      // At least one listener rule requires that same secret via an http-header condition before
      // forwarding/responding — i.e. the header CloudFront sends is actually enforced, not just sent.
      failoverTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
        Conditions: Match.arrayWith([
          Match.objectLike({
            Field: 'http-header',
            HttpHeaderConfig: Match.objectLike({
              HttpHeaderName: 'X-Origin-Verify',
              Values: [secret],
            }),
          }),
        ]),
      });
    });
  });
});
