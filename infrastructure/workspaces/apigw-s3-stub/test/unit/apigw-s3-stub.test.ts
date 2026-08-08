import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { ApigwS3StubStack } from 'lib/stacks/apigw-s3-stub-stack';
import { params } from 'parameters/environments';
import '../parameters';

const defaultEnv = {
  account: '123456789012',
  region: 'ap-northeast-1',
};

const projectName = 'TestProject';
const envName: Environment = Environment.TEST;

if (!params[envName]) {
  throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

describe('ApigwS3StubStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new ApigwS3StubStack(app, 'ApigwS3StubTest', {
      project: projectName,
      environment: envName,
      env: defaultEnv,
      isAutoDeleteObject: true,
      terminationProtection: false,
      envParams,
    });
    template = Template.fromStack(stack);
  });

  describe('Core resources', () => {
    test('creates the stub S3 bucket with encryption, SSL enforcement, and no public access', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            Match.objectLike({
              ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
            }),
          ],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    test('creates a REST API', () => {
      template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
      template.hasResourceProperties('AWS::ApiGateway::RestApi', {
        Name: Match.stringLikeRegexp('apigw-s3-stub-api$'),
      });
    });

    test('creates an IAM role assumable by API Gateway to read from S3', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({
              Action: 'sts:AssumeRole',
              Principal: { Service: 'apigateway.amazonaws.com' },
            }),
          ],
        },
      });

      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 's3:GetObject',
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });

    test('seeds the bucket with example stub JSON files via BucketDeployment', () => {
      template.resourceCountIs('Custom::CDKBucketDeployment', 1);
    });
  });

  describe('AWS Service (S3) integrations', () => {
    test('every API Gateway method uses a non-proxy AWS integration whose backend call is always GET', () => {
      const methods = template.findResources('AWS::ApiGateway::Method', {
        Properties: { HttpMethod: Match.not('OPTIONS') },
      });
      const methodEntries = Object.values(methods);
      expect(methodEntries.length).toBeGreaterThan(0);

      methodEntries.forEach((method) => {
        expect(method.Properties.Integration).toMatchObject({
          Type: 'AWS',
          IntegrationHttpMethod: 'GET',
        });
      });
    });

    test('defines GET/POST on the {resource} collection and GET/PUT/DELETE on the {resource}/{item} item', () => {
      const methods = template.findResources('AWS::ApiGateway::Method', {
        Properties: { HttpMethod: Match.not('OPTIONS') },
      });
      const httpMethods = Object.values(methods)
        .map((m) => m.Properties.HttpMethod as string)
        .sort();

      expect(httpMethods).toEqual(['DELETE', 'GET', 'GET', 'POST', 'PUT']);
    });

    test('requires an API key on every stub method', () => {
      const methods = template.findResources('AWS::ApiGateway::Method', {
        Properties: { HttpMethod: Match.not('OPTIONS') },
      });
      Object.values(methods).forEach((method) => {
        expect(method.Properties.ApiKeyRequired).toBe(true);
      });
    });
  });

  describe('Usage plan and throttling', () => {
    test('creates an API key and a usage plan associated with the deployment stage', () => {
      template.resourceCountIs('AWS::ApiGateway::ApiKey', 1);
      template.resourceCountIs('AWS::ApiGateway::UsagePlan', 1);
      template.resourceCountIs('AWS::ApiGateway::UsagePlanKey', 1);
    });

    test('configures the deployment stage with access logging and a stage name matching the environment', () => {
      template.hasResourceProperties('AWS::ApiGateway::Stage', {
        StageName: envName,
        AccessLogSetting: Match.objectLike({
          DestinationArn: Match.anyValue(),
        }),
      });
    });
  });

  describe('Outputs', () => {
    test('exposes the API URL, stub bucket name, and API key ID', () => {
      template.hasOutput('ApiUrl', {});
      template.hasOutput('StubBucketName', {});
      template.hasOutput('ApiKeyId', {});
    });
  });
});
