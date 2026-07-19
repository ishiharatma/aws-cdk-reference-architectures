import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { Environment } from "@common/parameters/environments";
import { defaultLambdaConfig , defaultFirehoseS3Config, defaultSqsConfig ,defaultLambdaEventSourceConfig } from 'lib/types';
import { EnvParams } from 'parameters/environments';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as pytonLambda from '@aws-cdk/aws-lambda-python-alpha';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs'
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cw from 'aws-cdk-lib/aws-cloudwatch';

export interface SqsLambdaFirehoseStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

export class SqsLambdaFirehoseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SqsLambdaFirehoseStackProps) {
    super(scope, id, props);

    const { params } = props;
    const sqsLambdaIntegrationParams = params.sqsLambdaIntegration;
    const lambdaFunctionParams = params.lambdaFunction;
    const firehoseParams = params.firehose;

    // Create a dead-letter queue
    const deadLetterQueue = new sqs.Queue(this, 'SqsFirehoseDeadLetterQueue', {
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    // Create an SQS queue
    const queue = new sqs.Queue(this, 'SqsFirehoseQueue', {
      queueName: sqsLambdaIntegrationParams.queueParams.queueNameSuffix ? `${props.project}-${props.environment}-${sqsLambdaIntegrationParams.queueParams.queueNameSuffix}` : undefined,  
      visibilityTimeout: sqsLambdaIntegrationParams.queueParams.visibilityTimeout || defaultSqsConfig.visibilityTimeout,
      retentionPeriod: sqsLambdaIntegrationParams.queueParams.retentionPeriod || defaultSqsConfig.retentionPeriod,
      receiveMessageWaitTime: sqsLambdaIntegrationParams.queueParams.receiveMessageWaitTime || defaultSqsConfig.receiveMessageWaitTime,
      deliveryDelay: sqsLambdaIntegrationParams.queueParams.deliveryDelay || defaultSqsConfig.deliveryDelay,
      encryption: sqsLambdaIntegrationParams.queueParams.encryption || defaultSqsConfig.encryption,
      fifo: sqsLambdaIntegrationParams.queueParams.fifo || defaultSqsConfig.fifo,
      deadLetterQueue: sqsLambdaIntegrationParams.queueParams.deadLetterQueueMaxReceiveCount ? {
        maxReceiveCount: sqsLambdaIntegrationParams.queueParams.deadLetterQueueMaxReceiveCount,
        queue: deadLetterQueue
      } : undefined,
      enforceSSL: true,
    });
    const queueFailure = new sqs.Queue(this, 'SqsFirehoseQueueFailure', {
      queueName: sqsLambdaIntegrationParams.queueParams.queueNameSuffix ? `${props.project}-${props.environment}-${sqsLambdaIntegrationParams.queueParams.queueNameSuffix}-failure` : undefined,  
      visibilityTimeout: sqsLambdaIntegrationParams.queueParams.visibilityTimeout || defaultSqsConfig.visibilityTimeout,
      retentionPeriod: sqsLambdaIntegrationParams.queueParams.retentionPeriod || defaultSqsConfig.retentionPeriod,
      receiveMessageWaitTime: sqsLambdaIntegrationParams.queueParams.receiveMessageWaitTime || defaultSqsConfig.receiveMessageWaitTime,
      deliveryDelay: sqsLambdaIntegrationParams.queueParams.deliveryDelay || defaultSqsConfig.deliveryDelay,
      encryption: sqsLambdaIntegrationParams.queueParams.encryption || defaultSqsConfig.encryption,
      fifo: sqsLambdaIntegrationParams.queueParams.fifo || defaultSqsConfig.fifo,
      deadLetterQueue: sqsLambdaIntegrationParams.queueParams.deadLetterQueueMaxReceiveCount ? {
        maxReceiveCount: sqsLambdaIntegrationParams.queueParams.deadLetterQueueMaxReceiveCount,
        queue: deadLetterQueue
      } : undefined,
      enforceSSL: true,
    });

    // Create a dead-letter queue for Lambda (if enabled)
    if (lambdaFunctionParams.deadLetterQueueEnabled && !lambdaFunctionParams.deadLetterQueue) {
      const lambdaDlq = new sqs.Queue(this, 'LambdaDeadLetterQueue', {
        retentionPeriod: cdk.Duration.days(14)
      });
      // Assign the created DLQ to the Lambda function parameters
      lambdaFunctionParams.deadLetterQueue = lambdaDlq;
    }

    // Create S3 bucket
    const s3Bucket = new s3.Bucket(this, 'SqsFirehoseBucket', {
      removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: props.isAutoDeleteObject,
      enforceSSL: true,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });
    // Adding more lifecycle rules
    s3Bucket.addLifecycleRule({
      id: "MoveToGlacierAfter90Days",
      enabled: true,
      transitions: [
        {
          storageClass: s3.StorageClass.GLACIER,
          transitionAfter: cdk.Duration.days(90),
        },
      ],
    });
    s3Bucket.addLifecycleRule({
      id: "ExpireAfter365Days",
      enabled: true,
      expiration: cdk.Duration.days(365),
    });
    // expire non-current versions
    s3Bucket.addLifecycleRule({
      id: "ExpireNonCurrentVersionsAfter90Days",
      enabled: true,
      noncurrentVersionExpiration: cdk.Duration.days(90),
      noncurrentVersionsToRetain: 3,
    });
    // transition non-current versions to IA after 30 days
    s3Bucket.addLifecycleRule({
      id: "NonCurrentVersionTransitionToIAAfter30Days",
      enabled: true,
      noncurrentVersionTransitions: [
        {
          storageClass: s3.StorageClass.INFREQUENT_ACCESS,
          transitionAfter: cdk.Duration.days(30),
        },
      ],
    });
    // transition current versions to IA after 60 days
    s3Bucket.addLifecycleRule({
      id: "CurrentVersionTransitionToIAAfter60Days",
      enabled: true,
      transitions: [
        {
          storageClass: s3.StorageClass.INFREQUENT_ACCESS,
          transitionAfter: cdk.Duration.days(60),
        },
      ],
    });
    // abort incomplete multipart uploads after 7 days
    s3Bucket.addLifecycleRule({
      id: "AbortIncompleteMultipartUploadsAfter7Days",
      enabled: true,
      abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
    });
    // Create IAM role for Firehose
    const firehoseRole = new iam.Role(this, 'FirehoseRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
      managedPolicies: [
        //iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'),
      ],
      inlinePolicies: {
        'AllowPutToS3': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                's3:AbortMultipartUpload',
                's3:ListBucket',
                's3:GetBucketLocation',
                's3:GetObject',
                's3:PutObject',
                's3:ListBucketMultipartUploads',
                's3:ListMultipartUploadParts'
              ],
              resources: [
                s3Bucket.bucketArn,
                s3Bucket.arnForObjects('*')
              ],
            }),
          ],
        }),
      },
    });

    // Setting up Firehose to deliver to S3
    const s3Destination = new firehose.S3Bucket(s3Bucket, {
      dataOutputPrefix: firehoseParams.dataOutputPrefix || defaultFirehoseS3Config.dataOutputPrefix,
      errorOutputPrefix: firehoseParams.errorOutputPrefix || defaultFirehoseS3Config.errorOutputPrefix,
      timeZone: firehoseParams.timeZone || defaultFirehoseS3Config.timeZone,
      bufferingInterval: firehoseParams.bufferingInterval || defaultFirehoseS3Config.bufferingInterval,
      bufferingSize: firehoseParams.bufferingSize || defaultFirehoseS3Config.bufferingSize,
      role: firehoseRole,
    });
    // Create a Firehose delivery stream
    const firehoseDeliveryStream = new firehose.DeliveryStream(this, 'SqsFirehoseDeliveryStream', {
      destination: s3Destination,
      encryption: firehose.StreamEncryption.awsOwnedKey(),
    });


    // Create a Lambda function
    const powertoolsEnv: Record<string, string> = {
      POWERTOOLS_METRICS_NAMESPACE: props.project,
      POWERTOOLS_SERVICE_NAME: `sqs-firehose-${props.environment}`,
    };
    const lambdaFunction = new pytonLambda.PythonFunction(this, 'SqsFirehoseFunction', {
      functionName: lambdaFunctionParams.functionNameSuffix ? `${props.project}-${props.environment}-${lambdaFunctionParams.functionNameSuffix}` : undefined,
      description: lambdaFunctionParams.description,
      runtime: lambdaFunctionParams.runtime || defaultLambdaConfig.runtime,
      handler: lambdaFunctionParams.handler || defaultLambdaConfig.handler,
      entry: lambdaFunctionParams.codeAssetPath,
      timeout: lambdaFunctionParams.timeout || defaultLambdaConfig.timeout,
      memorySize: lambdaFunctionParams.memorySize || defaultLambdaConfig.memorySize,
      environment: {...lambdaFunctionParams.environment, ...powertoolsEnv,
        PROJECT: props.project, 
        ENVIRONMENT: props.environment.toString(),
        FIREHOSE_DELIVERY_STREAM_NAME : firehoseDeliveryStream.deliveryStreamName
      },
      reservedConcurrentExecutions: lambdaFunctionParams.reservedConcurrentExecutions,
      tracing: lambdaFunctionParams.tracing || defaultLambdaConfig.tracing,
      applicationLogLevelV2: lambdaFunctionParams.logLevel || defaultLambdaConfig.logLevel,
      loggingFormat: lambda.LoggingFormat.JSON,
      logGroup: new logs.LogGroup(this, 'SqsFirehoseFunctionLogGroup', {
        retention: lambdaFunctionParams.logRetention || logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: {
        platform: lambdaFunctionParams.architecture || defaultLambdaConfig.architecture === lambda.Architecture.ARM_64 ? "linux/arm64" : "linux/amd64",
      },
      architecture: lambdaFunctionParams.architecture || defaultLambdaConfig.architecture,
      ephemeralStorageSize: lambdaFunctionParams.ephemeralStorageSize || defaultLambdaConfig.ephemeralStorageSize,
      insightsVersion: lambdaFunctionParams.insightsVersion,
      deadLetterQueueEnabled: lambdaFunctionParams.deadLetterQueueEnabled,
      deadLetterQueue: lambdaFunctionParams.deadLetterQueue,
      maxEventAge: lambdaFunctionParams.maxEventAge,
    });
    // Grant the Lambda function permissions to read from the SQS queue
    queue.grantConsumeMessages(lambdaFunction);
    // Set the Lambda function to be triggered by messages in the SQS queue
    lambdaFunction.addEventSource(new lambdaEventSources.SqsEventSource(queue,{
      batchSize: sqsLambdaIntegrationParams.eventSourceParams.batchSize || defaultLambdaEventSourceConfig.batchSize,
      maxBatchingWindow: sqsLambdaIntegrationParams.eventSourceParams.maxBatchingWindow || defaultLambdaEventSourceConfig.maxBatchingWindow,
      reportBatchItemFailures: sqsLambdaIntegrationParams.eventSourceParams.reportBatchItemFailures || defaultLambdaEventSourceConfig.reportBatchItemFailures,
      enabled: sqsLambdaIntegrationParams.eventSourceParams.enabled || defaultLambdaEventSourceConfig.enabled,
      maxConcurrency: sqsLambdaIntegrationParams.eventSourceParams.maxConcurrency || defaultLambdaEventSourceConfig.maxConcurrency,
    }));
    // Grant the Lambda function permissions to put records into the Firehose delivery stream
    firehoseDeliveryStream.grantPutRecords(lambdaFunction);

    // Create a Lambda function for failures
    const lambdaFunctionFailure = new pytonLambda.PythonFunction(this, 'SqsFirehoseFunctionFailure', {
      functionName: lambdaFunctionParams.functionNameSuffix ? `${props.project}-${props.environment}-${lambdaFunctionParams.functionNameSuffix}-failure` : undefined,
      description: lambdaFunctionParams.description,
      runtime: lambdaFunctionParams.runtime || defaultLambdaConfig.runtime,
      handler: lambdaFunctionParams.handler || defaultLambdaConfig.handler,
      entry: lambdaFunctionParams.codeAssetPath,
      timeout: lambdaFunctionParams.timeout || defaultLambdaConfig.timeout,
      memorySize: lambdaFunctionParams.memorySize || defaultLambdaConfig.memorySize,
      environment: {...lambdaFunctionParams.environment, ...powertoolsEnv,
        PROJECT: props.project, 
        ENVIRONMENT: props.environment.toString(),
        FIREHOSE_DELIVERY_STREAM_NAME : firehoseDeliveryStream.deliveryStreamName
      },
      reservedConcurrentExecutions: lambdaFunctionParams.reservedConcurrentExecutions,
      tracing: lambdaFunctionParams.tracing || defaultLambdaConfig.tracing,
      applicationLogLevelV2: lambdaFunctionParams.logLevel || defaultLambdaConfig.logLevel,
      loggingFormat: lambda.LoggingFormat.JSON,
      logGroup: new logs.LogGroup(this, 'SqsFirehoseFunctionFailureLogGroup', {
        retention: lambdaFunctionParams.logRetention || logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: {
        platform: lambdaFunctionParams.architecture || defaultLambdaConfig.architecture === lambda.Architecture.ARM_64 ? "linux/arm64" : "linux/amd64",
      },
      architecture: lambdaFunctionParams.architecture || defaultLambdaConfig.architecture,
      ephemeralStorageSize: lambdaFunctionParams.ephemeralStorageSize || defaultLambdaConfig.ephemeralStorageSize,
      insightsVersion: lambdaFunctionParams.insightsVersion,
      deadLetterQueueEnabled: lambdaFunctionParams.deadLetterQueueEnabled,
      deadLetterQueue: lambdaFunctionParams.deadLetterQueue,
      maxEventAge: lambdaFunctionParams.maxEventAge,
    });
    queueFailure.grantSendMessages(lambdaFunctionFailure);
    // Set the Lambda function to be triggered by messages in the SQS queue
    lambdaFunctionFailure.addEventSource(new lambdaEventSources.SqsEventSource(queueFailure,{
      batchSize: sqsLambdaIntegrationParams.eventSourceParams.batchSize || defaultLambdaEventSourceConfig.batchSize,
      maxBatchingWindow: sqsLambdaIntegrationParams.eventSourceParams.maxBatchingWindow || defaultLambdaEventSourceConfig.maxBatchingWindow,
      reportBatchItemFailures: sqsLambdaIntegrationParams.eventSourceParams.reportBatchItemFailures || defaultLambdaEventSourceConfig.reportBatchItemFailures,
      enabled: sqsLambdaIntegrationParams.eventSourceParams.enabled || defaultLambdaEventSourceConfig.enabled,
      maxConcurrency: sqsLambdaIntegrationParams.eventSourceParams.maxConcurrency || defaultLambdaEventSourceConfig.maxConcurrency,
    }));
    // ⚠️Do not grant permissions to Firehose for the failure function


    // Create Error Notification Topic and Subscription
    const errorNotificationTopic = new sns.Topic(this, 'SqsFirehoseErrorNotificationTopic', {
      displayName: `${props.project}-${props.environment}-sqs-firehose-error-notification-topic`,
      topicName: `${props.project}-${props.environment}-sqs-firehose-error-notification-topic`,
      enforceSSL: true,
    });
    // Create Metrics Alarm
    // Queue Alarm for Messages
    const sqsAlarms:cw.Alarm[] = this._createAlarmForSqs(queue);
    // Dead-letter Queue Alarm for SQS
    const dlqAlarms:cw.Alarm[] = this._createAlarmForDlq(deadLetterQueue);
    // Firehose
    const firehoseAlarms:cw.Alarm[] = this._createAlarmForFirehose(firehoseDeliveryStream);
    
    // Add SNS notification action to all alarms
    this._addNotificationToAlarms([...sqsAlarms, ...dlqAlarms, ...firehoseAlarms], errorNotificationTopic);

    // outputs
    new cdk.CfnOutput(this, 'SqsQueueUrl', {
      value: queue.queueUrl,
      description: 'URL of the SQS Queue',
    });
    new cdk.CfnOutput(this, 'SqsQueueFailureUrl', {
      value: queueFailure.queueUrl,
      description: 'URL of the SQS Failure Queue',
    });

    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: lambdaFunction.functionName,
      description: 'Name of the Lambda Function',
    });

    new cdk.CfnOutput(this, 'FirehoseDeliveryStreamName', {
      value: firehoseDeliveryStream.deliveryStreamName,
      description: 'Name of the Firehose Delivery Stream',
    });

    new cdk.CfnOutput(this, 'S3BucketName', {
      value: s3Bucket.bucketName,
      description: 'Name of the S3 Bucket',
    });
  }

  /**
   * Create CloudWatch Alarms for SQS Queue
   * @see https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/monitoring-using-cloudwatch.html
   * @param queue 
   */
  private _createAlarmForSqs(queue: sqs.Queue): cw.Alarm[] {
    const notificationAlarms:cw.Alarm[] = [];
    // Number of messages available to process
    /*
    const approximateNumberOfMessagesAlarm = queue.metricApproximateNumberOfMessagesVisible().createAlarm(this, 'SqsApproximateNumberOfMessages', {
      alarmName: 'SqsApproximateNumberOfMessagesAlarm',
      alarmDescription: 'Alarm when there are messages in the SQS Queue',
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    notificationAlarms.push(approximateNumberOfMessagesAlarm);
    */

    // Age of oldest message
    const approximateAgeOfOldestMessageAlarm = queue.metricApproximateAgeOfOldestMessage().createAlarm(this, 'SqsApproximateAgeOfOldestMessage', {
      alarmName: 'SqsApproximateAgeOfOldestMessageAlarm',
      alarmDescription: 'Alarm when the oldest message in the SQS Queue is old',
      threshold: 300, // 5 minutes
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    notificationAlarms.push(approximateAgeOfOldestMessageAlarm);

    // Count of empty receives
    const numberOfEmptyReceives = queue.metricNumberOfEmptyReceives().createAlarm(this, 'SqsNumberOfEmptyReceives', {
      alarmName: 'SqsNumberOfEmptyReceivesAlarm',
      alarmDescription: 'Alarm when there are many empty receives in the SQS Queue',
      threshold: 100,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    notificationAlarms.push(numberOfEmptyReceives);

    return notificationAlarms;
  }

  /**
   * Create CloudWatch Alarms for SQS Dead-letter Queue
   * @see https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/monitoring-using-cloudwatch.html
   * @param queue 
   */
  private _createAlarmForDlq(queue: sqs.Queue): cw.Alarm[] {
    const notificationAlarms:cw.Alarm[] = [];
    // Number of messages available to process
    const approximateNumberOfMessagesAlarm = queue.metricApproximateNumberOfMessagesVisible().createAlarm(this, 'SqsDlqApproximateNumberOfMessages', {
      alarmName: 'SqsDlqApproximateNumberOfMessagesAlarm',
      alarmDescription: 'Alarm when there are messages in the SQS Dead-letter Queue',
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    notificationAlarms.push(approximateNumberOfMessagesAlarm);

    return notificationAlarms;
  }

  /**
   * Create CloudWatch Alarms for Firehose Delivery Stream
   * @see: https://docs.aws.amazon.com/firehose/latest/dev/firehose-cloudwatch-metrics-best-practices.html
   * @param firehose 
   */
  private _createAlarmForFirehose(firehose: firehose.DeliveryStream): cw.Alarm[] {
    // Add CloudWatch alarms for when the following metrics exceed the buffering limit (a maximum of 15 minutes).
    /*
    const backupToS3DataFreshnessAlarm = firehose.metricBackupToS3DataFreshness().createAlarm(this, 'FirehoseBackupToS3DataFreshnessAlarm', {
      alarmName: 'FirehoseBackupToS3DataFreshnessAlarm',
      alarmDescription: 'Alarm when Firehose falls behind in delivering backup data to S3',
      threshold: 15,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    */
    const notificationAlarms:cw.Alarm[] = [];

   // DeliveryToS3.DataFreshness
    const deliveryToS3DataFreshnessAlarm = new cw.Alarm(this, 'FirehoseDeliveryToS3DataFreshnessAlarm', {
      alarmName: 'FirehoseDeliveryToS3DataFreshnessAlarm',
      alarmDescription: 'Alarm when Firehose falls behind in delivering data to S3',
      metric: new cw.Metric({
        namespace: 'AWS/Firehose',
        metricName: 'DeliveryToS3.DataFreshness',
        statistic: cw.Stats.AVERAGE,
        period: cdk.Duration.minutes(1),
        dimensionsMap: {
          DeliveryStreamName: firehose.deliveryStreamName,
        },
      }),
      threshold: 15 * 60, // 15 minutes in seconds
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    notificationAlarms.push(deliveryToS3DataFreshnessAlarm);
    // ThrottledRecords > 0
    const throttledRecordsAlarm = new cw.Alarm(this, 'FirehoseThrottledRecordsAlarm', {
      alarmName: 'FirehoseThrottledRecordsAlarm',
      alarmDescription: 'Alarm when Firehose has throttled records',
      metric: new cw.Metric({
        namespace: 'AWS/Firehose',
        metricName: 'ThrottledRecords',
        statistic: cw.Stats.SUM,
        period: cdk.Duration.minutes(5),
        dimensionsMap: {
          DeliveryStreamName: firehose.deliveryStreamName,
        },
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    notificationAlarms.push(throttledRecordsAlarm);

    // Alert threshold percentage (80% of quota limit)
    const quotaThresholdPercentage = 80;

    // High Incoming Bytes Per Second Alert
    // Formula: 100 * ((IncomingBytes Sum per 5min / 300) / BytesPerSecondLimit)
    const incomingBytesRateAlarm = new cw.Alarm(this, 'FirehoseIncomingBytesRateAlarm', {
      alarmName: `HighIncomingBytesPerSecondAlert-${firehose.deliveryStreamName}`,
      alarmDescription: `Alarm if Incoming Bytes Per Second rate is ${quotaThresholdPercentage}% of the current quota limit`,
      evaluationPeriods: 1,
      threshold: quotaThresholdPercentage,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      metric: new cw.MathExpression({
        expression: '100*(m1/300/m2)',
        usingMetrics: {
          m1: new cw.Metric({
            namespace: 'AWS/Firehose',
            metricName: 'IncomingBytes',
            dimensionsMap: {
              DeliveryStreamName: firehose.deliveryStreamName,
            },
            statistic: cw.Stats.SUM,
            period: cdk.Duration.minutes(5),
          }),
          m2: new cw.Metric({
            namespace: 'AWS/Firehose',
            metricName: 'BytesPerSecondLimit',
            dimensionsMap: {
              DeliveryStreamName: firehose.deliveryStreamName,
            },
            statistic: cw.Stats.MINIMUM,
            period: cdk.Duration.minutes(5),
          }),
        },
        label: 'Percentage of incoming Bytes per second quota used',
      }),
    });
    notificationAlarms.push(incomingBytesRateAlarm);

    // High Incoming Records Per Second Alert
    // Formula: 100 * ((IncomingRecords Sum per 5min / 300) / RecordsPerSecondLimit)
    const incomingRecordsRateAlarm = new cw.Alarm(this, 'FirehoseIncomingRecordsRateAlarm', {
      alarmName: `HighIncomingRecordsPerSecondAlert-${firehose.deliveryStreamName}`,
      alarmDescription: `Alarm if Incoming Records Per Second rate is ${quotaThresholdPercentage}% of the current quota limit`,
      evaluationPeriods: 1,
      threshold: quotaThresholdPercentage,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      metric: new cw.MathExpression({
        expression: '100*(m1/300/m2)',
        usingMetrics: {
          m1: new cw.Metric({
            namespace: 'AWS/Firehose',
            metricName: 'IncomingRecords',
            dimensionsMap: {
              DeliveryStreamName: firehose.deliveryStreamName,
            },
            statistic: cw.Stats.SUM,
            period: cdk.Duration.minutes(5),
          }),
          m2: new cw.Metric({
            namespace: 'AWS/Firehose',
            metricName: 'RecordsPerSecondLimit',
            dimensionsMap: {
              DeliveryStreamName: firehose.deliveryStreamName,
            },
            statistic: cw.Stats.MINIMUM,
            period: cdk.Duration.minutes(5),
          }),
        },
        label: 'Percentage of incoming records per second quota used',
      }),
    });
    notificationAlarms.push(incomingRecordsRateAlarm);

    // High Incoming Put Requests Per Second Alert
    // Formula: 100 * ((IncomingPutRequests Sum per 5min / 300) / PutRequestsPerSecondLimit)
    const incomingPutRequestsRateAlarm = new cw.Alarm(this, 'FirehoseIncomingPutRequestsRateAlarm', {
      alarmName: `HighIncomingPutRequestsPerSecondAlert-${firehose.deliveryStreamName}`,
      alarmDescription: `Alarm if incoming put requests per second rate is ${quotaThresholdPercentage}% of the current quota limit`,
      evaluationPeriods: 1,
      threshold: quotaThresholdPercentage,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      metric: new cw.MathExpression({
        expression: '100*(m1/300/m2)',
        usingMetrics: {
          m1: new cw.Metric({
            namespace: 'AWS/Firehose',
            metricName: 'IncomingPutRequests',
            dimensionsMap: {
              DeliveryStreamName: firehose.deliveryStreamName,
            },
            statistic: cw.Stats.SUM,
            period: cdk.Duration.minutes(5),
          }),
          m2: new cw.Metric({
            namespace: 'AWS/Firehose',
            metricName: 'PutRequestsPerSecondLimit',
            dimensionsMap: {
              DeliveryStreamName: firehose.deliveryStreamName,
            },
            statistic: cw.Stats.MINIMUM,
            period: cdk.Duration.minutes(5),
          }),
        },
        label: 'Percentage of incoming put requests quota used',
      }),
    });
    notificationAlarms.push(incomingPutRequestsRateAlarm);

    return notificationAlarms;
  }

  /**
   * Add SNS notification action to alarms
   * @param alarms 
   * @param topic 
   */
  private _addNotificationToAlarms(alarms: cw.Alarm[], topic: sns.Topic): void {
    const notificationAction = new cloudwatchActions.SnsAction(topic);
    for (const alarm of alarms) {
      alarm.addAlarmAction(notificationAction);
    }
  }
}
