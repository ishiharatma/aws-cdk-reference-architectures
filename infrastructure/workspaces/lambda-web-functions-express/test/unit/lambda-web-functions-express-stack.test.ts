import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CloudfrontWafStack } from 'lib/stacks/cloudfront-waf-stack';
import { buildStack, envName, projectName, testEnv, webAclArn } from '../helpers/stack';

const FUNCTION_NAME = 'test-test-lwf-todos';

describe('LambdaWebFunctionsExpressStack', () => {
  let template: Template;

  beforeAll(() => {
    template = Template.fromStack(buildStack());
  });

  describe('Web Function', () => {
    test('one Web Function, one revision, one endpoint and no Event Function for the API', () => {
      template.resourceCountIs('AWS::Lambda::WebFunction', 1);
      template.resourceCountIs('AWS::Lambda::WebFunctionRevision', 1);
      template.resourceCountIs('AWS::Lambda::WebFunctionEndpoint', 1);
      template.hasResourceProperties('AWS::Lambda::WebFunction', { FunctionName: FUNCTION_NAME });
    });

    test('no API Gateway in front of the function', () => {
      template.resourceCountIs('AWS::ApiGateway::RestApi', 0);
      template.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
    });

    test('revision runs nodejs24.x from the versioned code bucket with the stack parameters', () => {
      template.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
        FunctionName: FUNCTION_NAME,
        BuildConfig: {
          CodeConfig: {
            S3Object: {
              Bucket: { Ref: Match.stringLikeRegexp('TodosWebFunctionCodeBucket') },
              Key: Match.anyValue(),
              VersionId: Match.anyValue(),
            },
          },
          RuntimeConfig: { Runtime: 'nodejs24.x' },
        },
        ServiceConfig: {
          ExecutionRoleArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('TodosWebFunctionExecutionRole'), 'Arn'] },
          TimeoutSeconds: 30,
          MaxConcurrencyPerEnvironment: 64,
          EnvironmentVariables: {
            TABLE_NAME: { Ref: Match.stringLikeRegexp('TodosTable') },
            ENABLE_DEBUG_ROUTES: 'false',
          },
          TelemetryConfig: { LoggingConfig: { LogGroup: `/aws/lambda/web/${FUNCTION_NAME}` } },
        },
      });
    });

    test('revision and endpoint reference the function by bare name and depend on it explicitly', () => {
      const fnLogicalId = Object.keys(template.findResources('AWS::Lambda::WebFunction'))[0];
      const revisions = template.findResources('AWS::Lambda::WebFunctionRevision');
      const endpoints = template.findResources('AWS::Lambda::WebFunctionEndpoint');
      for (const resource of [...Object.values(revisions), ...Object.values(endpoints)]) {
        expect(resource.Properties.FunctionName).toBe(FUNCTION_NAME);
        expect(resource.DependsOn).toEqual(expect.arrayContaining([fnLogicalId]));
      }
      const revisionLogicalId = Object.keys(revisions)[0];
      expect(Object.values(endpoints)[0].DependsOn).toEqual(expect.arrayContaining([revisionLogicalId]));
    });

    test('endpoint is IamAuth, HomeRegion, 100% on the revision, with scaling and throttle caps', () => {
      template.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', {
        EndpointName: envName,
        EndpointType: 'HomeRegion',
        AuthType: 'IamAuth',
        RevisionWeights: [
          { RevisionId: { 'Fn::GetAtt': [Match.stringLikeRegexp('TodosWebFunctionRevision'), 'RevisionId'] }, Weight: 100 },
        ],
        ScalingConfig: { MaxEnvironments: 3 },
        ThrottleConfig: { RateLimit: 100 },
      });
    });
  });

  describe('Code bucket', () => {
    test('bucket is versioned, encrypted and blocks public access', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        VersioningConfiguration: { Status: 'Enabled' },
        BucketEncryption: Match.objectLike({}),
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    test('bucket policy lets only this account\'s Web Functions read the code', () => {
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'AllowLambdaWebFunctionsRead',
              Principal: { Service: 'lambda.amazonaws.com' },
              Action: ['s3:GetObject', 's3:GetObjectVersion'],
              Condition: {
                StringEquals: { 'aws:SourceAccount': testEnv.account },
                ArnLike: {
                  'aws:SourceArn': {
                    'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp(`:web-function/${FUNCTION_NAME}/\\*$`)])],
                  },
                },
              },
            }),
          ]),
        },
      });
    });

    test('zip is deployed without extraction so the key changes with the code', () => {
      template.hasResourceProperties('Custom::CDKBucketDeployment', {
        Extract: false,
        Prune: false,
        DestinationBucketKeyPrefix: 'code/',
      });
    });
  });

  describe('Logging', () => {
    test('log group uses the Web Functions path with a retention', () => {
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: `/aws/lambda/web/${FUNCTION_NAME}`,
        RetentionInDays: 7,
      });
    });

    test('the per-Region `.local` log group is owned by the stack (otherwise it outlives it)', () => {
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: `/aws/lambda/web/${FUNCTION_NAME}.local`,
        RetentionInDays: 7,
      });
      const revision = Object.values(template.findResources('AWS::Lambda::WebFunctionRevision'))[0];
      const local = Object.entries(template.findResources('AWS::Logs::LogGroup')).find(
        ([, r]) => r.Properties.LogGroupName === `/aws/lambda/web/${FUNCTION_NAME}.local`,
      );
      expect(local).toBeDefined();
      expect(revision.DependsOn).toEqual(expect.arrayContaining([local?.[0]]));
    });

    test('execution role can write only to the function log groups', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
              Resource: [
                { 'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp(`log-group:/aws/lambda/web/${FUNCTION_NAME}:\\*$`)])] },
                {
                  'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp(`log-group:/aws/lambda/web/${FUNCTION_NAME}\\.local:\\*$`)])],
                },
              ],
            }),
          ]),
        },
      });
    });

    test('execution role trusts lambda.amazonaws.com', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [Match.objectLike({ Principal: { Service: 'lambda.amazonaws.com' } })],
        },
        Description: Match.stringLikeRegexp('Lambda Web Function'),
      });
    });
  });

  describe('DynamoDB', () => {
    test('on-demand table with SSE and point-in-time recovery', () => {
      template.resourceCountIs('AWS::DynamoDB::Table', 1);
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'test-test-lwf-todos',
        BillingMode: 'PAY_PER_REQUEST',
        SSESpecification: { SSEEnabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
    });
  });

  describe('CloudFront', () => {
    test('OAC is lambda / always-amz-auth / sigv4 (the only behavior Web Function origins accept)', () => {
      template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
        OriginAccessControlConfig: {
          OriginAccessControlOriginType: 'lambda',
          SigningBehavior: 'always-amz-auth',
          SigningProtocol: 'sigv4',
        },
      });
    });

    test('distribution targets the endpoint domain over HTTPS with the OAC and the WAF', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          WebACLId: webAclArn,
          Origins: [
            Match.objectLike({
              DomainName: { 'Fn::GetAtt': [Match.stringLikeRegexp('TodosWebFunctionEndpoint'), 'DomainName'] },
              OriginAccessControlId: { 'Fn::GetAtt': ['WebFunctionOac', 'Id'] },
              CustomOriginConfig: Match.objectLike({ OriginProtocolPolicy: 'https-only' }),
            }),
          ],
        }),
      });
    });

    test('default behavior disables caching and does not forward the viewer Host header', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            // Managed-CachingDisabled / Managed-AllViewerExceptHostHeader
            CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
            OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
            ViewerProtocolPolicy: 'redirect-to-https',
            AllowedMethods: Match.arrayWith(['PUT', 'POST', 'DELETE']),
          }),
        }),
      });
    });

    test('resource policy allows only this distribution to invoke only this endpoint', () => {
      template.hasResourceProperties('AWS::Lambda::ResourcePolicy', {
        ResourceArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('TodosWebFunction'), 'FunctionArn'] },
        PolicyDocument: {
          Statement: [
            {
              Sid: 'AllowCloudFrontOAC',
              Effect: 'Allow',
              Principal: { Service: 'cloudfront.amazonaws.com' },
              Action: 'lambda:InvokeWebFunctionEndpoint',
              Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('TodosWebFunctionEndpoint'), 'EndpointArn'] },
              Condition: { StringEquals: { 'aws:SourceArn': Match.anyValue() } },
            },
          ],
        },
      });
    });
  });

  describe('Outputs', () => {
    test.each(['DistributionUrl', 'EndpointDomainName', 'WebFunctionName', 'RevisionId', 'LogGroupName'])(
      '%s is exported',
      (name) => {
        template.hasOutput(name, Match.anyValue());
      },
    );
  });
});

describe('LambdaWebFunctionsExpressStack with VPC egress', () => {
  const template = Template.fromStack(buildStack(undefined, { vpcEgress: { enabled: true, maxAzs: 2 } }));

  test('no network connector unless enabled', () => {
    Template.fromStack(buildStack()).resourceCountIs('AWS::Lambda::NetworkConnector', 0);
  });

  test('isolated VPC without NAT, with a DynamoDB gateway endpoint', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.resourceCountIs('AWS::EC2::InternetGateway', 0);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
      ServiceName: { 'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp('dynamodb')])] },
    });
  });

  test('VPC_EGRESS connector for WebFunction with an operator role', () => {
    template.hasResourceProperties('AWS::Lambda::NetworkConnector', {
      OperatorRole: { 'Fn::GetAtt': [Match.stringLikeRegexp('ConnectorOperatorRole'), 'Arn'] },
      Configuration: {
        VpcEgressConfiguration: Match.objectLike({
          AssociatedComputeResourceTypes: ['WebFunction'],
          NetworkProtocol: 'IPv4',
        }),
      },
    });
  });

  test('revision references the version-qualified connector ARN (LatestVersionArn, not Arn)', () => {
    template.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
      ServiceConfig: Match.objectLike({
        EgressNetworkConnectorArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('VpcEgressConnector'), 'LatestVersionArn'] },
      }),
    });
  });

  test('endpoint stays HomeRegion (connectors are Regional)', () => {
    template.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', { EndpointType: 'HomeRegion' });
  });
});

describe('CloudfrontWafStack', () => {
  const build = (allowedIps?: string[], allowedIpv6s?: string[]): Template => {
    const app = new cdk.App();
    return Template.fromStack(
      new CloudfrontWafStack(app, 'CloudfrontWaf', {
        project: projectName,
        environment: envName,
        allowedIps,
        allowedIpv6s,
        rateLimitPerIp: 1000,
        env: { account: testEnv.account, region: 'us-east-1' },
      }),
    );
  };

  test('CLOUDFRONT-scoped Web ACL blocks by default and rate-limits per IP first', () => {
    const template = build(['203.0.113.10']);
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      DefaultAction: { Block: {} },
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'RateLimitPerIp',
          Priority: 1,
          Statement: { RateBasedStatement: Match.objectLike({ AggregateKeyType: 'IP' }) },
        }),
        Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet' }),
        Match.objectLike({ Name: 'AWSManagedRulesKnownBadInputsRuleSet' }),
      ]),
    });
  });

  test('allow list uses /32 for explicit IPv4 addresses', () => {
    build(['203.0.113.10']).hasResourceProperties('AWS::WAFv2::IPSet', {
      IPAddressVersion: 'IPV4',
      Addresses: ['203.0.113.10/32'],
    });
  });

  test('without an allow list every IPv4 address is allowed after the managed rules', () => {
    build().hasResourceProperties('AWS::WAFv2::IPSet', { Addresses: ['0.0.0.0/1', '128.0.0.0/1'] });
  });

  test('IPv6 allow list adds a second IP set combined with OR', () => {
    const template = build(['203.0.113.10'], ['2001:db8::1']);
    template.resourceCountIs('AWS::WAFv2::IPSet', 2);
    template.hasResourceProperties('AWS::WAFv2::IPSet', { IPAddressVersion: 'IPV6', Addresses: ['2001:db8::1/128'] });
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({ Name: 'AllowListedIps', Statement: { OrStatement: Match.anyValue() } }),
      ]),
    });
  });
});
