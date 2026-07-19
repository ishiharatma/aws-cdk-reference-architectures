import * as cdk from 'aws-cdk-lib';

export const defaultSqsConfig = {
    visibilityTimeout: cdk.Duration.seconds(300),
    retentionPeriod: cdk.Duration.days(14),
    receiveMessageWaitTime: cdk.Duration.seconds(20),
    deliveryDelay: cdk.Duration.seconds(0),
    maxMessageSizeBytes: 256 * 1024, // 256KB
    enableDeadLetterQueue: false,
    deadLetterQueueMaxReceiveCount: 5,
    deadLetterQueueRetentionPeriod: cdk.Duration.days(14),
    fifo: false,
    contentBasedDeduplication: false,
    encryption: cdk.aws_sqs.QueueEncryption.SQS_MANAGED,
    dataKeyReuse: cdk.Duration.seconds(300),
};

export const defaultLambdaEventSourceConfig = {
    batchSize: 10,
    reportBatchItemFailures: false,
    enabled: true,
    maxBatchingWindow: cdk.Duration.seconds(60),
    maxConcurrency: undefined,
};

/**
 * SQS Queue Basic Parameters
 */
export interface SqsParams {
    /**
     * SQS Queue Name Suffix
     * @default undefined
     */
    readonly queueNameSuffix?: string;
    
    /**
     * Message Visibility Timeout
     * Recommended to be at least 6 times the Lambda function timeout
     * @default 300 seconds
     * @see https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html
     */
    readonly visibilityTimeout?: cdk.Duration;
    
    /**
     * Message Retention Period
     * @default 14 days
     */
    readonly retentionPeriod?: cdk.Duration;
    
    /**
     * Receive Message Wait Time (Long Polling)
     * @default 20 seconds
     */
    readonly receiveMessageWaitTime?: cdk.Duration;
    
    /**
     * Delivery Delay
     * @default 0 seconds
     */
    readonly deliveryDelay?: cdk.Duration;
    
    /**
     * Maximum Message Size (bytes)
     * @default 256KB
     */
    readonly maxMessageSizeBytes?: number;
    
    /**
     * Enable Dead Letter Queue
     * @default false
     */
    readonly enableDeadLetterQueue?: boolean;
    
    /**
     * Dead Letter Queue Max Receive Count
     * Maximum receive count before sending to DLQ
     * @default 5
     */
    readonly deadLetterQueueMaxReceiveCount?: number;
    
    /**
     * Dead Letter Queue Message Retention Period
     * @default 14 days
     */
    readonly deadLetterQueueRetentionPeriod?: cdk.Duration;
    
    /**
     * Enable FIFO Queue
     * @default false (Standard Queue)
     */
    readonly fifo?: boolean;
    
    /**
     * Enable Content-Based Deduplication (FIFO Queue only)
     * @default false
     */
    readonly contentBasedDeduplication?: boolean;
    
    /**
     * Deduplication Scope (FIFO Queue only)
     * @default undefined
     */
    readonly deduplicationScope?: cdk.aws_sqs.DeduplicationScope;
    
    /**
     * FIFO Throughput Limit (FIFO Queue only)
     * @default undefined
     */
    readonly fifoThroughputLimit?: cdk.aws_sqs.FifoThroughputLimit;
    
    /**
     * Enable KMS Encryption
     * @default false (SQS Managed Encryption)
     */
    readonly encryption?: cdk.aws_sqs.QueueEncryption;
    
    /**
     * Custom KMS Key (only if encryption=KMS)
     * @default undefined
     */
    readonly encryptionMasterKey?: cdk.aws_kms.IKey;
    
    /**
     * Data Key Reuse Period (seconds)
     * @default 300 seconds
     */
    readonly dataKeyReuse?: cdk.Duration;
}

/**
 * Lambda Event Source Mapping Parameters
 * @see https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html
 */
export interface LambdaEventSourceParams {
    /**
     * Batch Size (number of messages processed per Lambda invocation)
     * Standard Queue: 1-10,000
     * FIFO Queue: 1-10
     * @default 10
     */
    readonly batchSize?: number;
    
    /**
     * Maximum Batching Window
     * Maximum time to gather messages before processing, even if batch size is not reached
     * @default 60 seconds
     * @see https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html
     */
    readonly maxBatchingWindow?: cdk.Duration;
    
    /**
     * Enable Partial Batch Response
     * If some messages in the batch fail, only the successful messages are deleted
     * @default false
     */
    readonly reportBatchItemFailures?: boolean;
    
    /**
     * Enable Event Source Mapping
     * @default true
     */
    readonly enabled?: boolean;
    
    /**
     * Maximum Concurrency
     * Maximum number of SQS message batches that Lambda can process concurrently
     * @default undefined (no limit)
     */
    readonly maxConcurrency?: number;
    
    /**
     * Filter Conditions
     * Filters to send only specific messages to Lambda
     * @default undefined
     */
    readonly filters?: cdk.aws_lambda.EventSourceMappingOptions['filters'];
}

/**
 * SQS→Lambda Integration Parameters
 */
export interface SqsLambdaIntegrationParams {
    /**
     * SQS Queue Parameters
     */
    readonly queueParams: SqsParams;
    
    /**
     * Lambda Event Source Parameters
     */
    readonly eventSourceParams: LambdaEventSourceParams;
}