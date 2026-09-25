import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

export interface DynamodbVectorSearchSemanticApiStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/** Name of the DynamoDB vector index; also referenced by the search Lambda. */
export const VECTOR_INDEX_NAME = 'embedding-idx';
/** Attribute that holds the embedding (list of float32 numbers). */
const VECTOR_ATTRIBUTE = 'embedding';
/** Scalar attribute written together with the vector; marks an item as embedded (used by the stream filter). */
const EMBEDDED_FLAG_ATTRIBUTE = 'embeddedAt';
/** Non-key attribute used as a HASH/INLINE_FILTER in the vector index search schema. */
const FILTER_ATTRIBUTE = 'category';

/**
 * Semantic search API on DynamoDB native vector search.
 *
 *   POST /documents ─► ingest Lambda ─► DynamoDB table ──Streams──► embed Lambda ─► Bedrock (Titan V2)
 *                                            ▲  (writes `embedding` back)  │
 *   GET  /search?q= ─► search Lambda ─► Bedrock (embed query) ─► SearchVectors on the vector index
 *
 * The vector index is declared with the `VectorIndexes` property of AWS::DynamoDB::Table. The
 * aws-cdk-lib L2 `Table` construct has no first-class support for it yet, so it is applied to the
 * underlying CfnTable with `addPropertyOverride` (the CDK "escape hatch").
 */
export class DynamodbVectorSearchSemanticApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DynamodbVectorSearchSemanticApiStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const namePrefix = `${project}-${environment}-dvs`;

    // ---------------------------------------------------------------------------------------------
    // DynamoDB table with a native vector index
    // ---------------------------------------------------------------------------------------------
    const table = new dynamodb.Table(this, 'DocumentsTable', {
      tableName: `${namePrefix}-documents`,
      partitionKey: { name: 'docId', type: dynamodb.AttributeType.STRING },
      // Vector indexes are only supported on on-demand (PAY_PER_REQUEST) tables.
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy,
    });

    const cfnTable = table.node.defaultChild as dynamodb.CfnTable;
    // Every attribute named in a vector index SearchSchema must be declared in AttributeDefinitions
    // (CreateTable fails with "One element in SearchSchema is not defined in attribute definitions"
    // otherwise). The L2 construct only emits key/GSI attributes, so the list is replaced whole.
    cfnTable.addPropertyOverride('AttributeDefinitions', [
      { AttributeName: 'docId', AttributeType: 'S' },
      { AttributeName: FILTER_ATTRIBUTE, AttributeType: 'S' },
    ]);
    cfnTable.addPropertyOverride('VectorIndexes', [
      {
        IndexName: VECTOR_INDEX_NAME,
        VectorAttribute: { AttributeName: VECTOR_ATTRIBUTE },
        Dimensions: params.embeddingDimensions,
        DistanceFunction: 'COSINE',
        // INLINE_FILTER: `category` can be used in SearchConditionExpression and is evaluated inside
        // the vector search, so top-k stays exact under a filter.
        SearchSchema: [{ AttributeName: FILTER_ATTRIBUTE, SearchSchemaElementType: 'INLINE_FILTER' }],
        // Only what the search API returns. Projected attributes count against a shared limit and
        // increase vector index storage/write cost, so `body` is intentionally left out.
        Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['title', FILTER_ATTRIBUTE] },
      },
    ]);
    const vectorIndexArn = `${table.tableArn}/index/${VECTOR_INDEX_NAME}`;

    // ---------------------------------------------------------------------------------------------
    // Lambda functions
    // ---------------------------------------------------------------------------------------------
    const embeddingModelArn = `arn:${cdk.Aws.PARTITION}:bedrock:${this.region}::foundation-model/${params.embeddingModelId}`;

    const commonProps: Omit<lambdaNodejs.NodejsFunctionProps, 'entry' | 'functionName' | 'logGroup'> = {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        TABLE_NAME: table.tableName,
        VECTOR_INDEX_NAME,
        EMBEDDING_MODEL_ID: params.embeddingModelId,
        EMBEDDING_DIMENSIONS: String(params.embeddingDimensions),
      },
      bundling: {
        // Bundle the AWS SDK instead of using the copy baked into the Lambda runtime: the runtime
        // SDK version is not pinned and may predate the DynamoDB SearchVectors API.
        externalModules: [],
        minify: true,
        sourceMap: true,
        target: 'node24',
      },
    };

    const makeFunction = (idPrefix: string, entryFile: string, name: string, overrides: Partial<lambdaNodejs.NodejsFunctionProps> = {}) =>
      new lambdaNodejs.NodejsFunction(this, `${idPrefix}Function`, {
        ...commonProps,
        ...overrides,
        entry: path.join(__dirname, '../../src/handlers', `${entryFile}.ts`),
        functionName: `${namePrefix}-${name}`,
        logGroup: new logs.LogGroup(this, `${idPrefix}LogGroup`, {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy,
        }),
      });

    // Each function gets only the permissions its job needs.
    const ingestFunction = makeFunction('Ingest', 'ingest-document', 'ingest');
    ingestFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [table.tableArn] }),
    );

    const getFunction = makeFunction('GetDocument', 'get-document', 'get-document');
    getFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [table.tableArn] }),
    );

    const embedFunction = makeFunction('Embed', 'embed-document', 'embed', {
      // Bedrock calls dominate; allow headroom for throttling back-off.
      timeout: cdk.Duration.seconds(60),
    });
    embedFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:UpdateItem'], resources: [table.tableArn] }),
    );
    embedFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [embeddingModelArn] }),
    );

    const searchFunction = makeFunction('Search', 'search', 'search');
    searchFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:SearchVectors'], resources: [vectorIndexArn] }),
    );
    searchFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [embeddingModelArn] }),
    );

    // ---------------------------------------------------------------------------------------------
    // Stream -> embed Lambda, with a DLQ for records that keep failing
    // ---------------------------------------------------------------------------------------------
    const embedDlq = new sqs.Queue(this, 'EmbedDlq', {
      queueName: `${namePrefix}-embed-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy,
    });

    embedFunction.addEventSource(
      new lambdaEventSources.DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 5,
        maxBatchingWindow: cdk.Duration.seconds(1),
        reportBatchItemFailures: true,
        retryAttempts: 3,
        bisectBatchOnError: true,
        // One concurrent batch per shard (the default) keeps Bedrock InvokeModel calls well under the
        // account-level quota; raise it only for high write volumes.
        parallelizationFactor: 1,
        onFailure: new lambdaEventSources.SqsDlq(embedDlq),
        // Only records that have not been embedded yet reach the function. This drops the MODIFY
        // record produced by the function's own write-back, which would otherwise loop forever.
        // The rule must target the scalar `embeddedAt` (a leaf, `{"S": ...}`): Lambda's `exists`
        // operator only works on leaf nodes, so `exists: false` on the list-typed `embedding`
        // attribute matches every record and filters nothing. To re-embed an item (e.g. after a
        // model change), REMOVE its `embeddedAt` attribute.
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.or('INSERT', 'MODIFY'),
            dynamodb: { NewImage: { [EMBEDDED_FLAG_ATTRIBUTE]: { S: lambda.FilterRule.notExists() } } },
          }),
        ],
      }),
    );

    new cloudwatch.Alarm(this, 'EmbedDlqAlarm', {
      alarmName: `${namePrefix}-embed-dlq-not-empty`,
      alarmDescription: 'Documents failed embedding after all retries and were moved to the DLQ.',
      metric: embedDlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ---------------------------------------------------------------------------------------------
    // API Gateway (REST) protected by an API key + usage plan
    // ---------------------------------------------------------------------------------------------
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });

    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: `${namePrefix}-api`,
      description: 'Semantic search API backed by DynamoDB native vector search',
      cloudWatchRole: true,
      apiKeySourceType: apigateway.ApiKeySourceType.HEADER,
      deployOptions: {
        stageName: environment,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
    });

    // Rejects malformed requests (missing `q`, body not matching the model) before Lambda is invoked.
    const requestValidator = api.addRequestValidator('RequestValidator', {
      requestValidatorName: `${namePrefix}-request-validator`,
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    const createDocumentModel = api.addModel('CreateDocumentModel', {
      modelName: 'CreateDocument',
      contentType: 'application/json',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        type: apigateway.JsonSchemaType.OBJECT,
        required: ['title', 'body'],
        additionalProperties: false,
        properties: {
          title: { type: apigateway.JsonSchemaType.STRING, minLength: 1, maxLength: 200 },
          body: { type: apigateway.JsonSchemaType.STRING, minLength: 1, maxLength: 8000 },
          category: { type: apigateway.JsonSchemaType.STRING, pattern: '^[a-z0-9-]{1,32}$' },
        },
      },
    });

    const documents = api.root.addResource('documents');
    documents.addMethod('POST', new apigateway.LambdaIntegration(ingestFunction), {
      apiKeyRequired: true,
      requestValidator,
      requestModels: { 'application/json': createDocumentModel },
    });
    documents.addResource('{docId}').addMethod('GET', new apigateway.LambdaIntegration(getFunction), {
      apiKeyRequired: true,
      requestValidator,
      requestParameters: { 'method.request.path.docId': true },
    });
    api.root.addResource('search').addMethod('GET', new apigateway.LambdaIntegration(searchFunction), {
      apiKeyRequired: true,
      requestValidator,
      requestParameters: {
        'method.request.querystring.q': true,
        'method.request.querystring.k': false,
        'method.request.querystring.category': false,
      },
    });

    // Every search call costs a Bedrock invocation, so cap what a leaked key can spend.
    const apiKey = api.addApiKey('ApiKey', { apiKeyName: `${namePrefix}-key` });
    const usagePlan = api.addUsagePlan('UsagePlan', {
      name: `${namePrefix}-usage-plan`,
      throttle: { rateLimit: params.apiRateLimit, burstLimit: params.apiBurstLimit },
      quota: { limit: params.apiDailyQuota, period: apigateway.Period.DAY },
    });
    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: api.deploymentStage });

    // ---------------------------------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url, description: 'API Gateway URL' });
    new cdk.CfnOutput(this, 'ApiKeyId', {
      value: apiKey.keyId,
      description: 'API key ID (value: aws apigateway get-api-key --include-value --api-key <id>)',
    });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName, description: 'DynamoDB table name' });
    new cdk.CfnOutput(this, 'VectorIndexName', { value: VECTOR_INDEX_NAME, description: 'DynamoDB vector index name' });
    new cdk.CfnOutput(this, 'EmbedDlqUrl', { value: embedDlq.queueUrl, description: 'DLQ for failed embeddings' });
  }
}
