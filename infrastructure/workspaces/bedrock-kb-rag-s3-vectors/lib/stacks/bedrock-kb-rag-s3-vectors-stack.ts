import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

export interface BedrockKbRagS3VectorsStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/**
 * Retrieval-augmented generation on Amazon Bedrock Knowledge Bases with Amazon S3 Vectors as the vector store.
 *
 *   documents (S3) --ingestion: chunk, embed--> knowledge base --> S3 Vectors index
 *   client --SigV4--> HTTP API --> Lambda --RetrieveAndGenerate / Retrieve--> knowledge base --> answer + citations
 *
 * S3 Vectors has no cluster to size or pay for while idle (unlike OpenSearch Serverless), which is why it is the store here.
 */
export class BedrockKbRagS3VectorsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BedrockKbRagS3VectorsStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const namePrefix = `${project}-${environment}-kbrag`;
    const account = cdk.Stack.of(this).account;

    // ---------------------------------------------------------------------------------------------
    // Source documents
    // ---------------------------------------------------------------------------------------------
    const dataBucket = new s3.Bucket(this, 'DataBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: isAutoDeleteObject,
    });

    // ---------------------------------------------------------------------------------------------
    // Vector store: an S3 Vectors bucket and index
    // ---------------------------------------------------------------------------------------------
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName: `${namePrefix}-vectors-${account}`,
    });
    vectorBucket.applyRemovalPolicy(removalPolicy);
    const index = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketArn: vectorBucket.attrVectorBucketArn,
      indexName: `${namePrefix}-index`,
      dataType: 'float32',
      dimension: params.vectorDimension,
      distanceMetric: 'cosine',
      // Bedrock stores the chunk text and its metadata next to each vector. S3 Vectors allows only 2 KB of filterable
      // metadata per vector, so these two keys must be non-filterable or ingestion of longer chunks fails.
      metadataConfiguration: { nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'] },
    });
    index.applyRemovalPolicy(removalPolicy);

    // ---------------------------------------------------------------------------------------------
    // Knowledge base
    // ---------------------------------------------------------------------------------------------
    const embeddingModelArn = `arn:${this.partition}:bedrock:${this.region}::foundation-model/${params.embeddingModelId}`;
    const kbRole = new iam.Role(this, 'KnowledgeBaseRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:${this.partition}:bedrock:${this.region}:${account}:knowledge-base/*` },
        },
      }),
    });
    kbRole.addToPolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [embeddingModelArn] }));
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [dataBucket.bucketArn],
      conditions: { StringEquals: { 'aws:ResourceAccount': account } },
    }));
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [dataBucket.arnForObjects('*')],
      conditions: { StringEquals: { 'aws:ResourceAccount': account } },
    }));
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3vectors:GetIndex', 's3vectors:QueryVectors', 's3vectors:PutVectors', 's3vectors:GetVectors', 's3vectors:DeleteVectors', 's3vectors:ListVectors'],
      resources: [index.attrIndexArn],
    }));

    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: `${namePrefix}-kb`,
      description: 'Sample operations handbook for the RAG reference architecture',
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn,
          embeddingModelConfiguration: {
            bedrockEmbeddingModelConfiguration: { dimensions: params.vectorDimension, embeddingDataType: 'FLOAT32' },
          },
        },
      },
      storageConfiguration: { type: 'S3_VECTORS', s3VectorsConfiguration: { indexArn: index.attrIndexArn } },
    });
    knowledgeBase.node.addDependency(kbRole);

    const dataSource = new bedrock.CfnDataSource(this, 'DataSource', {
      name: `${namePrefix}-docs`,
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      dataDeletionPolicy: isAutoDeleteObject ? 'DELETE' : 'RETAIN',
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: { bucketArn: dataBucket.bucketArn, bucketOwnerAccountId: account },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'FIXED_SIZE',
          fixedSizeChunkingConfiguration: { maxTokens: params.chunking.maxTokens, overlapPercentage: params.chunking.overlapPercentage },
        },
      },
    });

    // ---------------------------------------------------------------------------------------------
    // API: HTTP API with IAM (SigV4) authorization in front of one Lambda function
    // ---------------------------------------------------------------------------------------------
    const profileArn = `arn:${this.partition}:bedrock:${this.region}:${account}:inference-profile/${params.generationInferenceProfileId}`;
    const fn = new lambdaNodejs.NodejsFunction(this, 'ApiFunction', {
      functionName: `${namePrefix}-api`,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '../../src/api/handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
        MODEL_ARN: profileArn,
        NUMBER_OF_RESULTS: String(params.numberOfResults),
        FILTER_ATTRIBUTE: params.filterAttribute,
      },
      logGroup: new logs.LogGroup(this, 'ApiLogGroup', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy }),
    });
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'RetrieveFromTheKnowledgeBase',
      actions: ['bedrock:Retrieve'],
      resources: [knowledgeBase.attrKnowledgeBaseArn],
    }));
    // RetrieveAndGenerate authorizes against the knowledge base, the inference profile and the model behind it.
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AnswerWithTheKnowledgeBase',
      actions: ['bedrock:RetrieveAndGenerate'],
      resources: ['*'],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'InvokeTheGenerationModel',
      actions: ['bedrock:InvokeModel', 'bedrock:GetInferenceProfile'],
      resources: [profileArn, `arn:${this.partition}:bedrock:*::foundation-model/${params.generationFoundationModelId}`],
    }));

    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy });
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${namePrefix}-api`,
      description: 'Questions and answers over the knowledge base',
      defaultAuthorizer: new apigwv2Authorizers.HttpIamAuthorizer(),
      createDefaultStage: false,
    });
    const integration = new apigwv2Integrations.HttpLambdaIntegration('ApiIntegration', fn);
    httpApi.addRoutes({ path: '/ask', methods: [apigwv2.HttpMethod.POST], integration });
    httpApi.addRoutes({ path: '/search', methods: [apigwv2.HttpMethod.POST], integration });
    const stage = new apigwv2.HttpStage(this, 'HttpApiStage', {
      httpApi,
      stageName: 'v1',
      autoDeploy: true,
      throttle: { rateLimit: params.apiRateLimit, burstLimit: params.apiBurstLimit },
      accessLogSettings: { destination: new apigwv2.LogGroupLogDestination(accessLogs) },
    });

    // ---------------------------------------------------------------------------------------------
    // Outputs (used by test-rag.sh)
    // ---------------------------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', { value: stage.url });
    new cdk.CfnOutput(this, 'KnowledgeBaseId', { value: knowledgeBase.attrKnowledgeBaseId });
    new cdk.CfnOutput(this, 'DataSourceId', { value: dataSource.attrDataSourceId });
    new cdk.CfnOutput(this, 'DataBucketName', { value: dataBucket.bucketName });
    new cdk.CfnOutput(this, 'VectorBucketName', { value: `${namePrefix}-vectors-${account}` });
    new cdk.CfnOutput(this, 'VectorIndexName', { value: `${namePrefix}-index` });
  }
}
