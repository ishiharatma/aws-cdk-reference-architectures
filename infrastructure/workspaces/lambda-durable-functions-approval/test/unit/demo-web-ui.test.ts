import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildStack } from '../helpers/stack';

describe('DemoWebUi', () => {
  const stack = buildStack();
  const template = Template.fromStack(stack);
  const distribution = stack.node.findChild('DemoWebUi').node.findChild('Distribution');
  const distributionId = stack.getLogicalId(distribution.node.defaultChild as cdk.CfnElement);
  const origin = {
    'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [distributionId, 'DomainName'] }]],
  };

  describe('identity', () => {
    test('user pool is admin-managed with a strong password policy', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
        Policies: {
          PasswordPolicy: Match.objectLike({
            MinimumLength: 12,
            RequireSymbols: true,
          }),
        },
        UserPoolTier: 'ESSENTIALS',
      });
    });

    test('web client is a public PKCE client restricted to the CloudFront origin', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        GenerateSecret: false,
        AllowedOAuthFlows: ['code'],
        AllowedOAuthScopes: ['openid', 'email'],
        CallbackURLs: [
          { 'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [distributionId, 'DomainName'] }, '/']] },
        ],
      });
    });

    test('identity pool denies guests and maps roles from the token', () => {
      template.hasResourceProperties('AWS::Cognito::IdentityPool', {
        AllowUnauthenticatedIdentities: false,
      });
      template.hasResourceProperties('AWS::Cognito::IdentityPoolRoleAttachment', {
        RoleMappings: {
          userpool: Match.objectLike({ Type: 'Token', AmbiguousRoleResolution: 'Deny' }),
        },
      });
    });

    test('groups carry their own IAM role, approvers take precedence', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
        GroupName: 'approvers',
        Precedence: 1,
        RoleArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('ApproverRole'), 'Arn'] },
      });
      template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
        GroupName: 'requesters',
        Precedence: 2,
        RoleArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('RequesterRole'), 'Arn'] },
      });
    });

    test('group roles trust only authenticated identities of this identity pool', () => {
      const roles = template.findResources('AWS::IAM::Role', {
        Properties: { Description: Match.stringLikeRegexp('^Demo UI') },
      });
      expect(Object.keys(roles)).toHaveLength(2);
      for (const role of Object.values(roles)) {
        const statement = role.Properties.AssumeRolePolicyDocument.Statement[0];
        expect(statement.Action).toBe('sts:AssumeRoleWithWebIdentity');
        expect(
          statement.Condition.StringEquals['cognito-identity.amazonaws.com:aud']
        ).toBeDefined();
        expect(statement.Condition['ForAnyValue:StringLike']).toEqual({
          'cognito-identity.amazonaws.com:amr': 'authenticated',
        });
      }
    });
  });

  describe('separation of duties in IAM', () => {
    const invokeResources = (rolePattern: string): string => {
      const policies = template.findResources('AWS::IAM::Policy', {
        Properties: { Roles: [{ Ref: Match.stringLikeRegexp(rolePattern) }] },
      });
      return JSON.stringify(Object.values(policies).map((p) => p.Properties.PolicyDocument));
    };

    test('requesters may submit and read, but not list or decide', () => {
      const doc = invokeResources('RequesterRole');
      expect(doc).toMatch(/\/POST\/requests"/);
      expect(doc).toMatch(/\/GET\/requests\/\*"/);
      expect(doc).not.toMatch(/decision/);
      expect(doc).not.toMatch(/\/GET\/requests"/);
    });

    test('approvers may list, read and decide, but not submit', () => {
      const doc = invokeResources('ApproverRole');
      expect(doc).toMatch(/\/GET\/requests"/);
      expect(doc).toMatch(/\/POST\/requests\/\*\/decision"/);
      expect(doc).not.toMatch(/\/POST\/requests"/);
    });
  });

  describe('hosting', () => {
    test('bucket is private and read through Origin Access Control', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
      template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    });

    test('distribution redirects to HTTPS and sends a CSP', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          DefaultRootObject: 'index.html',
          DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
        }),
      });
      template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: Match.objectLike({
          SecurityHeadersConfig: Match.objectLike({
            ContentSecurityPolicy: Match.objectLike({ Override: true }),
          }),
        }),
      });
    });

    test('SPA and config.json are published with an invalidation', () => {
      template.hasResourceProperties('Custom::CDKBucketDeployment', {
        DistributionPaths: ['/*'],
      });
    });
  });

  describe('CORS', () => {
    test('preflight methods are the only unauthenticated ones', () => {
      const methods = Object.values(template.findResources('AWS::ApiGateway::Method'));
      const options = methods.filter((m) => m.Properties.HttpMethod === 'OPTIONS');
      expect(options).toHaveLength(3);
      for (const method of options) {
        expect(method.Properties.AuthorizationType).toBe('NONE');
      }
    });

    test('API Gateway error responses carry the UI origin', () => {
      for (const type of ['DEFAULT_4XX', 'DEFAULT_5XX']) {
        template.hasResourceProperties('AWS::ApiGateway::GatewayResponse', {
          ResponseType: type,
          ResponseParameters: Match.objectLike({
            'gatewayresponse.header.Access-Control-Allow-Origin': {
              'Fn::Join': [
                '',
                ["'https://", { 'Fn::GetAtt': [distributionId, 'DomainName'] }, "'"],
              ],
            },
          }),
        });
      }
    });

    test('handlers echo the UI origin', () => {
      for (const name of ['start-request', 'submit-decision', 'get-request', 'list-requests']) {
        template.hasResourceProperties('AWS::Lambda::Function', {
          FunctionName: `test-test-ldf-${name}`,
          Environment: { Variables: Match.objectLike({ CORS_ALLOW_ORIGIN: origin }) },
        });
      }
    });
  });

  describe('when disabled', () => {
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const disabled = Template.fromStack(buildStack(app, { demoWebUi: { enabled: false } }));

    test('creates no identity, hosting or CORS resources', () => {
      for (const type of [
        'AWS::Cognito::UserPool',
        'AWS::Cognito::IdentityPool',
        'AWS::CloudFront::Distribution',
        'AWS::S3::Bucket',
        'AWS::ApiGateway::GatewayResponse',
      ]) {
        disabled.resourceCountIs(type, 0);
      }
      const methods = Object.values(disabled.findResources('AWS::ApiGateway::Method'));
      expect(methods.map((m) => m.Properties.HttpMethod)).not.toContain('OPTIONS');
      expect(JSON.stringify(disabled.toJSON())).not.toMatch(/CORS_ALLOW_ORIGIN/);
    });
  });
});
