/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { DynamodbVectorSearchSemanticApiStack } from 'lib/stacks/dynamodb-vector-search-semantic-api-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const projectName = 'test';
const envName: Environment = Environment.TEST;
const envParams = params[envName];
if (!envParams) {
  throw new Error(`No parameters found for environment: ${envName}`);
}

describe('DynamodbVectorSearchSemanticApiStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new DynamodbVectorSearchSemanticApiStack(app, 'DynamodbVectorSearchSemanticApi', {
      project: projectName,
      environment: envName,
      isAutoDeleteObject: true,
      env: testEnv,
      params: envParams,
    });
    template = Template.fromStack(stack);
  });

  /** All IAM statements attached to the role of the Lambda function whose name ends with `suffix`. */
  const statementsFor = (suffix: string): any[] => {
    const fn = Object.values(template.findResources('AWS::Lambda::Function')).find((f: any) =>
      String(f.Properties.FunctionName).endsWith(suffix),
    ) as any;
    const roleRef = fn.Properties.Role['Fn::GetAtt'][0];
    return Object.values(template.findResources('AWS::IAM::Policy'))
      .filter((p: any) => JSON.stringify(p.Properties.Roles).includes(roleRef))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  };

  describe('DynamoDB table and vector index', () => {
    test('on-demand table (required for vector indexes) with SSE, PITR and a NEW_IMAGE stream', () => {
      template.resourceCountIs('AWS::DynamoDB::Table', 1);
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        BillingMode: 'PAY_PER_REQUEST',
        SSESpecification: { SSEEnabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
        KeySchema: [{ AttributeName: 'docId', KeyType: 'HASH' }],
      });
    });

    test('vector index is declared through VectorIndexes with the configured dimensions and COSINE', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        VectorIndexes: [
          {
            IndexName: 'embedding-idx',
            VectorAttribute: { AttributeName: 'embedding' },
            Dimensions: envParams.embeddingDimensions,
            DistanceFunction: 'COSINE',
            SearchSchema: [{ AttributeName: 'category', SearchSchemaElementType: 'INLINE_FILTER' }],
            Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['title', 'category'] },
          },
        ],
      });
    });

    test('every SearchSchema attribute is declared in AttributeDefinitions', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        AttributeDefinitions: Match.arrayEquals([
          { AttributeName: 'docId', AttributeType: 'S' },
          { AttributeName: 'category', AttributeType: 'S' },
        ]),
      });
    });
  });

  describe('Lambda functions', () => {
    test('four functions on ARM64 Node.js 24, each with its own log group', () => {
      template.resourceCountIs('AWS::Lambda::Function', 4);
      template.allResourcesProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
      });
      // 4 function log groups + 1 API Gateway access-log group
      template.resourceCountIs('AWS::Logs::LogGroup', 5);
    });

    test('functions receive the table, index, model and dimensions via environment variables', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-test-dvs-search',
        Environment: {
          Variables: {
            VECTOR_INDEX_NAME: 'embedding-idx',
            EMBEDDING_MODEL_ID: envParams.embeddingModelId,
            EMBEDDING_DIMENSIONS: String(envParams.embeddingDimensions),
          },
        },
      });
    });
  });

  describe('IAM least privilege', () => {
    test('search function can call SearchVectors only on the vector index, and only the embedding model', () => {
      const statements = statementsFor('-search');
      const actions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
      // CloudWatch Logs permissions come from the AWSLambdaBasicExecutionRole managed policy, not inline statements.
      expect(actions.sort()).toEqual(['bedrock:InvokeModel', 'dynamodb:SearchVectors']);

      const searchStatement = statements.find((s) => s.Action === 'dynamodb:SearchVectors');
      expect(JSON.stringify(searchStatement.Resource)).toContain('/index/embedding-idx');
      const bedrockStatement = statements.find((s) => s.Action === 'bedrock:InvokeModel');
      expect(JSON.stringify(bedrockStatement.Resource)).toContain(`foundation-model/${envParams.embeddingModelId}`);
    });

    test('embed function can only UpdateItem and invoke the embedding model', () => {
      const actions = statementsFor('-embed')
        .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
        .filter((a: string) => a.startsWith('dynamodb:') || a.startsWith('bedrock:'));
      expect(actions.sort()).toEqual(
        [
          'bedrock:InvokeModel',
          'dynamodb:UpdateItem',
          // added by the DynamoDB event source
          'dynamodb:DescribeStream',
          'dynamodb:GetRecords',
          'dynamodb:GetShardIterator',
          'dynamodb:ListStreams',
        ].sort(),
      );
    });

    test('ingest and get functions have single-action DynamoDB access', () => {
      const dynamoActions = (suffix: string) =>
        statementsFor(suffix)
          .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
          .filter((a: string) => a.startsWith('dynamodb:'));
      expect(dynamoActions('-ingest')).toEqual(['dynamodb:PutItem']);
      expect(dynamoActions('-get-document')).toEqual(['dynamodb:GetItem']);
    });
  });

  describe('Stream -> embed Lambda', () => {
    test('event source mapping filters on the scalar embeddedAt leaf to avoid a write-back loop', () => {
      template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
        StartingPosition: 'TRIM_HORIZON',
        BatchSize: 5,
        BisectBatchOnFunctionError: true,
        MaximumRetryAttempts: 3,
        FunctionResponseTypes: ['ReportBatchItemFailures'],
        FilterCriteria: {
          Filters: [
            {
              Pattern: JSON.stringify({
                eventName: ['INSERT', 'MODIFY'],
                dynamodb: { NewImage: { embeddedAt: { S: [{ exists: false }] } } },
              }),
            },
          ],
        },
        DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
      });
    });

    test('failed records go to an encrypted DLQ that raises an alarm', () => {
      template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'test-test-dvs-embed-dlq', SqsManagedSseEnabled: true });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'ApproximateNumberOfMessagesVisible',
        Threshold: 1,
      });
    });
  });

  describe('API Gateway', () => {
    test('every method requires an API key and has a request validator', () => {
      const methods = Object.values(template.findResources('AWS::ApiGateway::Method')).filter(
        (m: any) => m.Properties.HttpMethod !== 'OPTIONS',
      );
      expect(methods).toHaveLength(3);
      methods.forEach((m: any) => {
        expect(m.Properties.ApiKeyRequired).toBe(true);
        expect(m.Properties.RequestValidatorId).toBeDefined();
      });
    });

    test('search requires q and treats k and category as optional', () => {
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'GET',
        RequestParameters: {
          'method.request.querystring.q': true,
          'method.request.querystring.k': false,
          'method.request.querystring.category': false,
        },
      });
    });

    test('POST body is validated against a JSON schema model', () => {
      template.hasResourceProperties('AWS::ApiGateway::Model', {
        Schema: Match.objectLike({ required: ['title', 'body'], additionalProperties: false }),
      });
    });

    test('usage plan caps request rate and daily quota to bound Bedrock spend', () => {
      template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
        Throttle: { RateLimit: envParams.apiRateLimit, BurstLimit: envParams.apiBurstLimit },
        Quota: { Limit: envParams.apiDailyQuota, Period: 'DAY' },
      });
    });
  });

  describe('Outputs', () => {
    test('exposes the values needed by test-semantic-search.sh', () => {
      const outputs = Object.keys(template.toJSON().Outputs);
      ['ApiUrl', 'ApiKeyId', 'TableName', 'VectorIndexName', 'EmbedDlqUrl'].forEach((name) => {
        expect(outputs).toContain(name);
      });
    });
  });
});
