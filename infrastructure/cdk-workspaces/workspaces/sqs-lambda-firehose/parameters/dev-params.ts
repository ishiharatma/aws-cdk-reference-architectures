import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { EnvParams, params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 * 
 * This configuration creates:
 * - SQS Queue with Dead Letter Queue
 * - Lambda function for processing SQS messages
 * - Event Source Mapping between SQS and Lambda
 * 
 * Configuration optimized for:
 * - Low latency processing
 * - Quick debugging and development
 * - Cost-effective for development workloads
 */
const devParams: EnvParams = {
  // Stack name prefix
  stackNamePrefix: 'sqs-lambda-firehose',

  // SQS and Lambda integration parameters
  sqsLambdaIntegration: {
    queueParams: {
      // Set to at least 6 times the Lambda function timeout (5 seconds)
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.days(4),
      receiveMessageWaitTime: cdk.Duration.seconds(20), // Enable Long Polling
      deliveryDelay: cdk.Duration.seconds(0),
      enableDeadLetterQueue: true,
      deadLetterQueueMaxReceiveCount: 3,
      deadLetterQueueRetentionPeriod: cdk.Duration.days(14),
      // Use standard queue in development environment
      fifo: false,
      // Use SQS managed encryption (development environment)
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    },
    eventSourceParams: {
      // Process small number of messages quickly
      batchSize: 5,
      // No batching window (process immediately)
      maxBatchingWindow: undefined,
      // Enable partial batch response
      reportBatchItemFailures: true,
      enabled: true,
    },
  },

  // Lambda function parameters
  lambdaFunction: {
    runtime: lambda.Runtime.PYTHON_3_14,
    handler: 'lambda_handler',
    codeAssetPath: '../../common/src/python-lambda/sqs-firehose-powertools',
    // SQS visibilityTimeout is 30 seconds, so set to 5 seconds or less
    timeout: cdk.Duration.seconds(5),
    memorySize: 256,
    environment: {
      ENVIRONMENT: Environment.DEVELOPMENT,
    },
    tracing: lambda.Tracing.ACTIVE, // Enable X-Ray
    logLevel: lambda.ApplicationLogLevel.DEBUG, // Enable detailed logging
    logRetention: logs.RetentionDays.ONE_WEEK,
    architecture: lambda.Architecture.X86_64, // Use x86_64 for development compatibility
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
params[Environment.DEVELOPMENT] = devParams;
