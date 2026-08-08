import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as logDestinations from 'aws-cdk-lib/aws-logs-destinations';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Environment } from '@common/parameters/environments';
import { defaultSnsBasicConfig } from 'lib/types';
import { EnvParams } from 'parameters/environments';

export interface SnsBasicStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly params: EnvParams;
}

const PYTHON_LAMBDA_DIR = path.join(__dirname, '../../../../common/src/python-lambda');

/**
 * sns-basic reference architecture
 *
 * Demonstrates the main SNS subscription protocols by fanning a single
 * topic out to every supported destination type, plus a second
 * "CloudWatch Logs -> Lambda -> SNS -> Lambda" chain showing SNS used as a
 * lightweight alerting hop:
 *
 *   MainTopic (SNS)
 *     -> Email
 *     -> SQS (MessageQueue) -> Lambda (sqs-message-logger)
 *     -> Lambda (sns-message-logger, direct subscription)
 *     -> HTTPS (API Gateway) -> Lambda (sns-http-endpoint) -> S3 + DynamoDB
 *     -> Amazon Data Firehose -> S3 (no Lambda involved)
 *
 *   CloudWatch Logs (AppLogGroup)
 *     -> Subscription Filter -> Lambda (cwlogs-to-sns)
 *     -> LogAlertTopic (SNS) -> Lambda (log-alert-notifier, direct subscription)
 */
export class SnsBasicStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: SnsBasicStackProps) {
        super(scope, id, props);

        const snsBasicParams = props.params.snsBasic ?? {};
        const notificationEmail = snsBasicParams.notificationEmail ?? defaultSnsBasicConfig.notificationEmail;
        const functionMemorySize = snsBasicParams.functionMemorySize ?? defaultSnsBasicConfig.functionMemorySize;
        const functionTimeout = snsBasicParams.functionTimeout ?? defaultSnsBasicConfig.functionTimeout;
        const functionLogRetention = snsBasicParams.functionLogRetention ?? defaultSnsBasicConfig.functionLogRetention;
        const apiHandlerMemorySize = snsBasicParams.apiHandlerMemorySize ?? defaultSnsBasicConfig.apiHandlerMemorySize;
        const apiHandlerTimeout = snsBasicParams.apiHandlerTimeout ?? defaultSnsBasicConfig.apiHandlerTimeout;
        const cwLogsFilterPattern = snsBasicParams.cwLogsFilterPattern ?? defaultSnsBasicConfig.cwLogsFilterPattern;
        const cwLogsRetention = snsBasicParams.cwLogsRetention ?? defaultSnsBasicConfig.cwLogsRetention;
        const firehoseBufferingInterval = snsBasicParams.firehoseBufferingInterval ?? defaultSnsBasicConfig.firehoseBufferingInterval;
        const firehoseBufferingSize = snsBasicParams.firehoseBufferingSize ?? defaultSnsBasicConfig.firehoseBufferingSize;

        const removalPolicy = props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

        // AWS-managed SNS KMS key: satisfies encryption-at-rest (AwsSolutions-SNS2)
        // without the cost/operational overhead of a customer-managed key.
        const snsManagedKey = kms.Alias.fromAliasName(this, 'SnsManagedKey', 'alias/aws/sns');

        // -----------------------------------------------------------------------
        // Main SNS Topic
        // -----------------------------------------------------------------------
        const mainTopic = new sns.Topic(this, 'MainTopic', {
            topicName: `${props.project}-${props.environment}-sns-basic-main`,
            displayName: 'SNS Basic main fan-out topic',
            enforceSSL: true,
            masterKey: snsManagedKey,
        });

        mainTopic.addSubscription(new snsSubscriptions.EmailSubscription(notificationEmail));

        // -----------------------------------------------------------------------
        // SQS branch: MainTopic -> SQS -> Lambda (log only)
        // -----------------------------------------------------------------------
        const messageDeadLetterQueue = new sqs.Queue(this, 'MessageQueueDlq', {
            queueName: `${props.project}-${props.environment}-sns-basic-message-dlq`,
            enforceSSL: true,
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            retentionPeriod: cdk.Duration.days(14),
        });

        const messageQueue = new sqs.Queue(this, 'MessageQueue', {
            queueName: `${props.project}-${props.environment}-sns-basic-message`,
            enforceSSL: true,
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            visibilityTimeout: cdk.Duration.seconds(30),
            deadLetterQueue: {
                queue: messageDeadLetterQueue,
                maxReceiveCount: 3,
            },
        });

        mainTopic.addSubscription(new snsSubscriptions.SqsSubscription(messageQueue, {
            rawMessageDelivery: true,
        }));

        const sqsMessageLoggerFunction = new lambda.Function(this, 'SqsMessageLoggerFunction', {
            functionName: `${props.project}-${props.environment}-sqs-message-logger`,
            description: 'Logs messages delivered via the SQS subscription to the main SNS topic',
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.lambda_handler',
            code: lambda.Code.fromAsset(path.join(PYTHON_LAMBDA_DIR, 'sqs-message-logger')),
            memorySize: functionMemorySize,
            timeout: functionTimeout,
            logGroup: new logs.LogGroup(this, 'SqsMessageLoggerLogGroup', {
                retention: functionLogRetention,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
            loggingFormat: lambda.LoggingFormat.JSON,
            applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
        });

        sqsMessageLoggerFunction.addEventSource(new lambdaEventSources.SqsEventSource(messageQueue, {
            batchSize: 10,
            reportBatchItemFailures: true,
        }));

        // -----------------------------------------------------------------------
        // Direct Lambda subscription branch: MainTopic -> Lambda (log only)
        // -----------------------------------------------------------------------
        const snsMessageLoggerFunction = new lambda.Function(this, 'SnsMessageLoggerFunction', {
            functionName: `${props.project}-${props.environment}-sns-message-logger`,
            description: 'Logs messages delivered via the direct Lambda subscription to the main SNS topic',
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.lambda_handler',
            code: lambda.Code.fromAsset(path.join(PYTHON_LAMBDA_DIR, 'sns-message-logger')),
            memorySize: functionMemorySize,
            timeout: functionTimeout,
            logGroup: new logs.LogGroup(this, 'SnsMessageLoggerLogGroup', {
                retention: functionLogRetention,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
            loggingFormat: lambda.LoggingFormat.JSON,
            applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
        });

        mainTopic.addSubscription(new snsSubscriptions.LambdaSubscription(snsMessageLoggerFunction));

        // -----------------------------------------------------------------------
        // HTTPS branch: MainTopic -> API Gateway -> Lambda -> S3 + DynamoDB
        // -----------------------------------------------------------------------
        const payloadBucket = new s3.Bucket(this, 'PayloadBucket', {
            removalPolicy,
            autoDeleteObjects: props.isAutoDeleteObject,
            enforceSSL: true,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });
        payloadBucket.addLifecycleRule({
            id: 'AbortIncompleteMultipartUploadsAfter7Days',
            enabled: true,
            abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        });

        const payloadTable = new dynamodb.Table(this, 'PayloadTable', {
            tableName: `${props.project}-${props.environment}-sns-basic-payload`,
            partitionKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
            removalPolicy,
        });

        const apiHandlerFunction = new lambda.Function(this, 'ApiHandlerFunction', {
            functionName: `${props.project}-${props.environment}-sns-http-endpoint`,
            description: 'API Gateway backend for the HTTPS subscription to the main SNS topic: '
                + 'confirms the subscription and stores notifications in S3/DynamoDB',
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.lambda_handler',
            code: lambda.Code.fromAsset(path.join(PYTHON_LAMBDA_DIR, 'sns-http-endpoint')),
            memorySize: apiHandlerMemorySize,
            timeout: apiHandlerTimeout,
            environment: {
                EXPECTED_TOPIC_ARN: mainTopic.topicArn,
                S3_BUCKET_NAME: payloadBucket.bucketName,
                DDB_TABLE_NAME: payloadTable.tableName,
            },
            logGroup: new logs.LogGroup(this, 'ApiHandlerFunctionLogGroup', {
                retention: functionLogRetention,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
            loggingFormat: lambda.LoggingFormat.JSON,
            applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
        });

        payloadBucket.grantWrite(apiHandlerFunction);
        payloadTable.grantWriteData(apiHandlerFunction);

        const apiAccessLogGroup = new logs.LogGroup(this, 'ApiAccessLogGroup', {
            retention: functionLogRetention,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const api = new apigateway.RestApi(this, 'SnsBasicApi', {
            restApiName: `${props.project}-${props.environment}-sns-basic-api`,
            description: 'Receives SNS HTTPS subscription confirmations/notifications for the main SNS topic',
            endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
            cloudWatchRole: false,
            deployOptions: {
                stageName: props.environment,
                accessLogDestination: new apigateway.LogGroupLogDestination(apiAccessLogGroup),
                accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
                loggingLevel: apigateway.MethodLoggingLevel.INFO,
            },
        });

        const requestValidator = api.addRequestValidator('SnsBasicRequestValidator', {
            validateRequestBody: true,
            validateRequestParameters: true,
        });

        const snsResource = api.root.addResource('sns');
        snsResource.addMethod('POST', new apigateway.LambdaIntegration(apiHandlerFunction), {
            requestValidator,
        });

        // SNS HTTPS subscriptions receive a SubscriptionConfirmation message that
        // must be confirmed; sns-http-endpoint fetches SubscribeURL to do so.
        // `protocol` must be given explicitly because the API URL is an
        // unresolved CloudFormation token at synth time.
        mainTopic.addSubscription(new snsSubscriptions.UrlSubscription(api.urlForPath('/sns'), {
            protocol: sns.SubscriptionProtocol.HTTPS,
        }));

        // -----------------------------------------------------------------------
        // Firehose branch: MainTopic -> Amazon Data Firehose -> S3 (no Lambda)
        // -----------------------------------------------------------------------
        const firehoseArchiveBucket = new s3.Bucket(this, 'FirehoseArchiveBucket', {
            removalPolicy,
            autoDeleteObjects: props.isAutoDeleteObject,
            enforceSSL: true,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });
        firehoseArchiveBucket.addLifecycleRule({
            id: 'AbortIncompleteMultipartUploadsAfter7Days',
            enabled: true,
            abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        });

        const firehoseRole = new iam.Role(this, 'FirehoseRole', {
            assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
            inlinePolicies: {
                AllowPutToS3: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            actions: [
                                's3:AbortMultipartUpload',
                                's3:ListBucket',
                                's3:GetBucketLocation',
                                's3:GetObject',
                                's3:PutObject',
                                's3:ListBucketMultipartUploads',
                                's3:ListMultipartUploadParts',
                            ],
                            resources: [
                                firehoseArchiveBucket.bucketArn,
                                firehoseArchiveBucket.arnForObjects('*'),
                            ],
                        }),
                    ],
                }),
            },
        });

        const firehoseS3Destination = new firehose.S3Bucket(firehoseArchiveBucket, {
            dataOutputPrefix: 'sns-basic/!{timestamp:yyyy/MM/dd}/',
            errorOutputPrefix: 'sns-basic-errors/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/',
            bufferingInterval: firehoseBufferingInterval,
            bufferingSize: firehoseBufferingSize,
            role: firehoseRole,
        });

        const mainTopicDeliveryStream = new firehose.DeliveryStream(this, 'MainTopicDeliveryStream', {
            deliveryStreamName: `${props.project}-${props.environment}-sns-basic-main`,
            destination: firehoseS3Destination,
            encryption: firehose.StreamEncryption.awsOwnedKey(),
        });

        mainTopic.addSubscription(new snsSubscriptions.FirehoseSubscription(mainTopicDeliveryStream, {
            rawMessageDelivery: true,
        }));

        // -----------------------------------------------------------------------
        // CloudWatch Logs -> Lambda -> SNS -> Lambda chain
        // -----------------------------------------------------------------------
        const logAlertTopic = new sns.Topic(this, 'LogAlertTopic', {
            topicName: `${props.project}-${props.environment}-sns-basic-log-alert`,
            displayName: 'SNS Basic log-alert topic',
            enforceSSL: true,
            masterKey: snsManagedKey,
        });

        // Demo application log group; in a real workload this would be an
        // existing log group produced by another service. Use
        // `aws logs put-log-events` to exercise this branch (see README).
        const appLogGroup = new logs.LogGroup(this, 'AppLogGroup', {
            logGroupName: `/${props.project}/${props.environment}/sns-basic/app`,
            retention: cwLogsRetention,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const cwLogsToSnsFunction = new lambda.Function(this, 'CwLogsToSnsFunction', {
            functionName: `${props.project}-${props.environment}-cwlogs-to-sns`,
            description: 'Decodes CloudWatch Logs subscription filter events and publishes a summary to the log-alert SNS topic',
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.lambda_handler',
            code: lambda.Code.fromAsset(path.join(PYTHON_LAMBDA_DIR, 'cwlogs-to-sns')),
            memorySize: functionMemorySize,
            timeout: functionTimeout,
            environment: {
                TOPIC_ARN: logAlertTopic.topicArn,
            },
            logGroup: new logs.LogGroup(this, 'CwLogsToSnsFunctionLogGroup', {
                retention: functionLogRetention,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
            loggingFormat: lambda.LoggingFormat.JSON,
            applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
        });

        logAlertTopic.grantPublish(cwLogsToSnsFunction);

        // LambdaDestination automatically adds the Lambda::Permission that
        // allows logs.amazonaws.com to invoke the function.
        new logs.SubscriptionFilter(this, 'AppLogSubscriptionFilter', {
            logGroup: appLogGroup,
            destination: new logDestinations.LambdaDestination(cwLogsToSnsFunction),
            filterPattern: cwLogsFilterPattern
                ? logs.FilterPattern.literal(cwLogsFilterPattern)
                : logs.FilterPattern.allEvents(),
        });

        const logAlertNotifierFunction = new lambda.Function(this, 'LogAlertNotifierFunction', {
            functionName: `${props.project}-${props.environment}-log-alert-notifier`,
            description: 'Logs messages delivered via the direct Lambda subscription to the log-alert SNS topic',
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.lambda_handler',
            code: lambda.Code.fromAsset(path.join(PYTHON_LAMBDA_DIR, 'log-alert-notifier')),
            memorySize: functionMemorySize,
            timeout: functionTimeout,
            logGroup: new logs.LogGroup(this, 'LogAlertNotifierFunctionLogGroup', {
                retention: functionLogRetention,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
            loggingFormat: lambda.LoggingFormat.JSON,
            applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
        });

        logAlertTopic.addSubscription(new snsSubscriptions.LambdaSubscription(logAlertNotifierFunction));

        // -----------------------------------------------------------------------
        // Stack Outputs
        // -----------------------------------------------------------------------
        new cdk.CfnOutput(this, 'MainTopicArn', {
            value: mainTopic.topicArn,
            description: 'ARN of the main SNS topic',
        });
        new cdk.CfnOutput(this, 'LogAlertTopicArn', {
            value: logAlertTopic.topicArn,
            description: 'ARN of the log-alert SNS topic',
        });
        new cdk.CfnOutput(this, 'ApiUrl', {
            value: api.urlForPath('/sns'),
            description: 'API Gateway endpoint subscribed to the main SNS topic',
        });
        new cdk.CfnOutput(this, 'AppLogGroupName', {
            value: appLogGroup.logGroupName,
            description: 'Demo application log group name (use `aws logs put-log-events` to test)',
        });
        new cdk.CfnOutput(this, 'PayloadBucketName', {
            value: payloadBucket.bucketName,
            description: 'S3 bucket receiving notifications from the API Gateway backend',
        });
        new cdk.CfnOutput(this, 'PayloadTableName', {
            value: payloadTable.tableName,
            description: 'DynamoDB table receiving notifications from the API Gateway backend',
        });
        new cdk.CfnOutput(this, 'FirehoseArchiveBucketName', {
            value: firehoseArchiveBucket.bucketName,
            description: 'S3 bucket receiving raw messages via Amazon Data Firehose',
        });
    }
}
