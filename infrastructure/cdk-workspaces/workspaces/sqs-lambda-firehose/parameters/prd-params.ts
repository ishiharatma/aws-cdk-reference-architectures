import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Production Environment Parameters
 * 
 * This configuration creates:
 * - SQS Queue with Dead Letter Queue
 * - Lambda function for processing SQS messages
 * - Event Source Mapping between SQS and Lambda
 * 
 * Configuration optimized for:
 * - High throughput and cost efficiency
 * - Enhanced monitoring and observability
 * - Production-grade reliability
 */
const prdParams: EnvParams = {
  // Stack name prefix
  stackNamePrefix: 'sqs-lambda-firehose',

  // SQS and Lambda integration parameters
  sqsLambdaIntegration: {
    queueParams: {
      // Lambda function timeout (30 seconds) should be at least 6 times this value
      visibilityTimeout: cdk.Duration.seconds(180),
      retentionPeriod: cdk.Duration.days(14),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      deliveryDelay: cdk.Duration.seconds(0),
      enableDeadLetterQueue: true,
      deadLetterQueueMaxReceiveCount: 5,
      deadLetterQueueRetentionPeriod: cdk.Duration.days(14),
      // Standard queue in production environment
      fifo: false,
      // Use KMS encryption (production environment)
      encryption: sqs.QueueEncryption.KMS_MANAGED,
    },
    eventSourceParams: {
      // Batch more messages for cost reduction
      batchSize: 10,
      // Collect messages for up to 5 minutes
      maxBatchingWindow: cdk.Duration.minutes(5),
      reportBatchItemFailures: true,
      enabled: true,
      // Limit concurrency to prevent throttling
      maxConcurrency: 100,
    },
  },

  // Lambda function parameters
  lambdaFunction: {
    runtime: lambda.Runtime.PYTHON_3_14,
    handler: 'lambda_handler',
    codeAssetPath: '../../common/src/python-lambda/sqs-firehose-powertools',
    // SQS visibilityTimeout is 180 seconds, so set timeout to 30 seconds or less
    timeout: cdk.Duration.seconds(30),
    memorySize: 512,
    environment: {
      ENVIRONMENT: Environment.PRODUCTION,
    },
    reservedConcurrentExecutions: 100, // Reserved concurrent executions
    tracing: lambda.Tracing.ACTIVE,
    logLevel: lambda.ApplicationLogLevel.INFO, // Standard logging level
    logRetention: logs.RetentionDays.ONE_MONTH,
    architecture: lambda.Architecture.X86_64,
    insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_229_0, // Enable Lambda Insights
    deadLetterQueueEnabled: true, // Enable Lambda's own DLQ
    maxEventAge: cdk.Duration.hours(6),
  },
  // Firehose parameters
  firehose: {
    dataOutputPrefix: "!{timestamp:yyyy/MM/dd}/",
    errorOutputPrefix: "!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/",
    timeZone: cdk.TimeZone.ASIA_TOKYO,
    bufferingInterval: cdk.Duration.minutes(1),
    bufferingSize: cdk.Size.mebibytes(1),
  },
};

// Register in the params object
params[Environment.PRODUCTION] = prdParams;