/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { BedrockKbRagS3VectorsStack } from 'lib/stacks/bedrock-kb-rag-s3-vectors-stack';
import { params } from 'parameters/environments';
import '../parameters';

const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
const envParams = params[Environment.TEST];
if (!envParams) {
  throw new Error('No parameters found for test environment');
}

const build = (overrides: Partial<typeof envParams> = {}, isAutoDeleteObject = true) => {
  const app = new cdk.App();
  const stack = new BedrockKbRagS3VectorsStack(app, 'BedrockKbRagS3Vectors', {
    project: 'test',
    environment: Environment.TEST,
    isAutoDeleteObject,
    env: testEnv,
    params: { ...envParams, ...overrides },
  });
  return Template.fromStack(stack);
};

describe('BedrockKbRagS3VectorsStack', () => {
  const template = build();

  describe('vector store', () => {
    test('an S3 Vectors index sized for the embedding model, with cosine distance', () => {
      template.hasResourceProperties('AWS::S3Vectors::Index', {
        DataType: 'float32',
        Dimension: envParams.vectorDimension,
        DistanceMetric: 'cosine',
      });
    });

    test('the chunk text and metadata keys Bedrock writes are non-filterable (2 KB filterable limit)', () => {
      template.hasResourceProperties('AWS::S3Vectors::Index', {
        MetadataConfiguration: { NonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'] },
      });
    });

    test('the index and the knowledge base agree on the dimension', () => {
      template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
        KnowledgeBaseConfiguration: Match.objectLike({
          VectorKnowledgeBaseConfiguration: Match.objectLike({
            EmbeddingModelConfiguration: { BedrockEmbeddingModelConfiguration: { Dimensions: envParams.vectorDimension, EmbeddingDataType: 'FLOAT32' } },
          }),
        }),
        StorageConfiguration: Match.objectLike({ Type: 'S3_VECTORS' }),
      });
    });
  });

  describe('knowledge base and data source', () => {
    test('the data source is the private data bucket, with fixed-size chunking from the parameters', () => {
      template.hasResourceProperties('AWS::Bedrock::DataSource', {
        DataSourceConfiguration: Match.objectLike({ Type: 'S3' }),
        VectorIngestionConfiguration: {
          ChunkingConfiguration: {
            ChunkingStrategy: 'FIXED_SIZE',
            FixedSizeChunkingConfiguration: { MaxTokens: envParams.chunking.maxTokens, OverlapPercentage: envParams.chunking.overlapPercentage },
          },
        },
      });
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        BucketEncryption: Match.anyValue(),
      });
    });

    test('indexed data is deleted with the data source in development and retained in production', () => {
      template.hasResourceProperties('AWS::Bedrock::DataSource', { DataDeletionPolicy: 'DELETE' });
      build({}, false).hasResourceProperties('AWS::Bedrock::DataSource', { DataDeletionPolicy: 'RETAIN' });
    });

    test('the service role is assumable by Bedrock for this account and its knowledge bases only', () => {
      const role = Object.values(template.findResources('AWS::IAM::Role', {
        Properties: { AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Principal: { Service: 'bedrock.amazonaws.com' } })] } },
      })) as any[];
      expect(role).toHaveLength(1);
      const condition = role[0].Properties.AssumeRolePolicyDocument.Statement[0].Condition;
      expect(condition.StringEquals['aws:SourceAccount']).toBe(testEnv.account);
      expect(JSON.stringify(condition.ArnLike)).toContain('knowledge-base/*');
    });

    test('the service role can embed with the configured model and use only its own index', () => {
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(policies).toContain(`foundation-model/${envParams.embeddingModelId}`);
      ['s3vectors:QueryVectors', 's3vectors:PutVectors', 's3vectors:DeleteVectors'].forEach((a) => expect(policies).toContain(a));
    });
  });

  describe('API', () => {
    test('an HTTP API with IAM authorization on both routes', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /ask', AuthorizationType: 'AWS_IAM' });
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /search', AuthorizationType: 'AWS_IAM' });
    });

    test('the stage throttles and writes access logs', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
        StageName: 'v1',
        DefaultRouteSettings: { ThrottlingRateLimit: envParams.apiRateLimit, ThrottlingBurstLimit: envParams.apiBurstLimit },
        AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue() }),
      });
    });

    test('the function gets the knowledge base, the inference profile and the retrieval settings', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-test-kbrag-api',
        Architectures: ['arm64'],
        Environment: {
          Variables: Match.objectLike({
            NUMBER_OF_RESULTS: String(envParams.numberOfResults),
            FILTER_ATTRIBUTE: envParams.filterAttribute,
            MODEL_ARN: Match.anyValue(),
            KNOWLEDGE_BASE_ID: Match.anyValue(),
          }),
        },
      });
      expect(JSON.stringify(template.toJSON().Resources)).toContain(`inference-profile/${envParams.generationInferenceProfileId}`);
    });

    test('the function role can retrieve, answer and invoke the generation model but not change the knowledge base', () => {
      const policies = JSON.stringify(Object.values(template.findResources('AWS::IAM::Policy', {
        Properties: { PolicyName: Match.stringLikeRegexp('^ApiFunctionServiceRole') },
      })));
      ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate', 'bedrock:InvokeModel'].forEach((a) => expect(policies).toContain(a));
      ['bedrock:StartIngestionJob', 'bedrock:DeleteKnowledgeBase', 'bedrock:CreateKnowledgeBase', 's3:', 's3vectors:'].forEach((a) =>
        expect(policies).not.toContain(a));
    });
  });
});
