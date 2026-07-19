# SQS-Lambda-Firehose — Building Event-Driven Data Pipelines

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

## Introduction

This project is a reference implementation that uses the AWS CDK to build an event-driven data pipeline that combines SQS, Lambda, and Firehose.

This architecture demonstrates the following implementations:

- SQS + Dead Letter Queue design
- Lambda **ReportBatchItemFailures** for batch processing
- Firehose → S3 streaming delivery
- Production monitoring with CloudWatch Alarms

### Why SQS-Lambda-Firehose?

| Feature | Benefit |
| ------ | --------- |
| Event-Driven | Loosely coupled and scalable |
| Reliability | Robust error handling with DLQ and batch failure reporting |
| Cost Efficiency | Serverless with pay-per-use pricing |
| Reduced Ops | Minimize infrastructure management with managed services |

## Architecture Overview

![Architecture Overview](overview.png)

---

## Prerequisites

- AWS CLI v2 installed and configured
- Node.js 20+
- AWS CDK CLI (`npm install -g aws-cdk`)
- Basic TypeScript knowledge
- AWS accounts
- AWS CLI profile configuration for each account

## Project Directory Structure

```text
sqs-lambda-firehose/
├── bin/
│   └── sqs-lambda-firehose.ts                   # Application entry point
├── lib/
│   ├── stacks/
│   │   └── sqs-lambda-firehose-stack.ts         # Stack
│   ├── stages/
│   │   └── sqs-lambda-firehose-stage.ts         # Deployment orchestration
│   └── types/
│       └── vpc-peering-params.ts         # Parameter type definitions
├── parameters/
│   └── environments.ts                   # Environment-specific parameters
└── test/
    ├── compliance/
    │   └── cdk-nag.test.ts               # CDK Nag compliance test
    ├── snapshot/
    │   └── snapshot.test.ts              # Snapshot test
    └── unit/
        └── sqs-lambda-firehose.test.ts   # stack test 
```

---

### Data Flow

```text
Producer → SQS Queue → Lambda → Firehose → S3
                ↓ (on failure)
           Dead Letter Queue
```

### Key Components and Design Points

| Component | Design Points |
| ------------- | ------------ |
| SQS Queue | Long Polling (20s), Visibility Timeout (30s), SSL enforcement |
| Dead Letter Queue | Move to DLQ after 3 failures, 14-day retention |
| Lambda | Batch size 5, **ReportBatchItemFailures enabled**, X-Ray enabled |
| SQS Queue (for Failure Lambda) | Long Polling (20s), Visibility Timeout (30s), SSL enforcement |
| Lambda (Failure) | Lambda without Firehose permissions for DLQ behavior validation |
| Firehose | 1min/1MB buffering, partitioned prefix |
| S3 | Lifecycle management (60d→IA, 90d→Glacier, 365d→Delete) |
| CloudWatch | 8 alarms + SNS notifications |

---

## Implementation Highlights

### 1. SQS + Dead Letter Queue

DLQ configuration is critical for isolating failed messages and enabling investigation and reprocessing.

```typescript
// Dead Letter Queue
const deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
  retentionPeriod: cdk.Duration.days(14),
  enforceSSL: true,
});

// Main Queue with DLQ
const queue = new sqs.Queue(this, 'MainQueue', {
  visibilityTimeout: cdk.Duration.seconds(30),
  receiveMessageWaitTime: cdk.Duration.seconds(20), // Long Polling
  deadLetterQueue: {
    maxReceiveCount: 3, // Move to DLQ after 3 failures
    queue: deadLetterQueue,
  },
  enforceSSL: true,
});
```

> **Best Practice**: Set Visibility Timeout to **at least 6 times** the Lambda timeout ([see documentation](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-configure-lambda-function-trigger.html))

### 2. Lambda - ReportBatchItemFailures

When only some messages in a batch fail, you can reprocess only the failed ones.

```typescript
lambdaFunction.addEventSource(
  new lambdaEventSources.SqsEventSource(queue, {
    batchSize: 5,
    reportBatchItemFailures: true, // Support partial failures
  })
);
```

#### Without Powertools vs With Powertools

<details>
<summary>❌ Without Powertools (Manual Implementation)</summary>

```python
def lambda_handler(event, context):
    records = event.get("Records", [])
    batch_item_failures = []

    for record in records:
        message_id = record.get("messageId")
        message_body = record.get("body", "")

        try:
            process_message(message_body)
        except Exception as e:
            # Manually add failed record ID
            batch_item_failures.append({"itemIdentifier": message_id})

    # Manually construct response format
    return {"batchItemFailures": batch_item_failures}
```

</details>

**Problems:**

- Need to manually add `itemIdentifier` to batch_item_failures
- Must construct response format accurately
- Lots of error handling boilerplate
- Testing becomes complex

<details open>
<summary>✅ With Powertools (Recommended)</summary>

```python
from aws_lambda_powertools.utilities.batch import (
    BatchProcessor, EventType, process_partial_response
)

processor = BatchProcessor(event_type=EventType.SQS)

def record_handler(record):
    """Process each record - just raise exception on failure"""
    payload = record.json_body
    send_to_firehose(payload)

def lambda_handler(event, context):
    return process_partial_response(
        event=event,
        record_handler=record_handler,
        processor=processor,
        context=context
    )
```

</details>

**Benefits:**

- `itemIdentifier` extraction and setting are automated
- No need to worry about response format
- `record_handler` can focus solely on processing logic
- Just raise an exception on failure

| Item | Manual Implementation | Powertools |
| ------ | --------- | ------------ |
| Code Volume | Large | Small |
| Bug Risk | High (itemIdentifier mistakes, etc.) | Low |
| Test Ease | Complex | Simple |
| Metrics | Manual addition | Auto-collection available |

<details>
<summary>📝 Complete Lambda Function Code (Python)</summary>

```python
import json
import os
import boto3
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.utilities.batch import (
    BatchProcessor, EventType, process_partial_response
)
from aws_lambda_powertools.utilities.data_classes.sqs_event import SQSRecord

logger = Logger()
tracer = Tracer()
metrics = Metrics()

processor = BatchProcessor(event_type=EventType.SQS)
firehose_client = boto3.client('firehose')
delivery_stream_name = os.environ['FIREHOSE_DELIVERY_STREAM_NAME']

@tracer.capture_method
def record_handler(record: SQSRecord):
    """Process individual record"""
    payload = record.json_body
    logger.info("Processing message", extra={"message_id": record.message_id})

    response = firehose_client.put_record(
        DeliveryStreamName=delivery_stream_name,
        Record={'Data': json.dumps(payload) + '\n'}
    )

    logger.info("Sent to Firehose", extra={"record_id": response['RecordId']})
    metrics.add_metric(name="ProcessedMessages", unit="Count", value=1)

@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    return process_partial_response(
        event=event,
        record_handler=record_handler,
        processor=processor,
        context=context
    )
```

</details>

### 3. Firehose - Partitioned Delivery

Improves S3 query performance and analysis efficiency with Athena and similar tools.

```typescript
const deliveryStream = new firehose.DeliveryStream(this, 'DeliveryStream', {
  destination: new firehose.S3Bucket(bucket, {
    dataOutputPrefix: '!{timestamp:yyyy/MM/dd}/',      // Partition by date
    errorOutputPrefix: '!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/',
    bufferingInterval: cdk.Duration.minutes(1),
    bufferingSize: cdk.Size.mebibytes(1),
  }),
});
```

### 4. S3 Lifecycle Management

```typescript
bucket.addLifecycleRule({
  transitions: [
    { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(60) },
    { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(90) },
  ],
  expiration: cdk.Duration.days(365),
});
```

<details>
<summary>📝 Complete Stack Implementation Code</summary>

```typescript
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as pythonLambda from '@aws-cdk/aws-lambda-python-alpha';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';

export class SqsLambdaFirehoseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SqsLambdaFirehoseStackProps) {
    super(scope, id, props);

    // 1. Dead Letter Queue
    const deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // 2. Main Queue
    const queue = new sqs.Queue(this, 'MainQueue', {
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.days(4),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      deadLetterQueue: { maxReceiveCount: 3, queue: deadLetterQueue },
      enforceSSL: true,
    });

    // 3. S3 Bucket
    const bucket = new s3.Bucket(this, 'DataBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    bucket.addLifecycleRule({
      transitions: [
        { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(60) },
        { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(90) },
      ],
      expiration: cdk.Duration.days(365),
    });

    // 4. Firehose
    const deliveryStream = new firehose.DeliveryStream(this, 'DeliveryStream', {
      destination: new firehose.S3Bucket(bucket, {
        dataOutputPrefix: '!{timestamp:yyyy/MM/dd}/',
        errorOutputPrefix: '!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/',
        bufferingInterval: cdk.Duration.minutes(1),
        bufferingSize: cdk.Size.mebibytes(1),
      }),
    });

    // 5. Lambda Function
    const lambdaFunction = new pythonLambda.PythonFunction(this, 'ProcessorFunction', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'lambda_handler',
      entry: '../../common/src/python-lambda/sqs-firehose',
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      environment: {
        FIREHOSE_DELIVERY_STREAM_NAME: deliveryStream.deliveryStreamName,
      },
      tracing: lambda.Tracing.ACTIVE,
      loggingFormat: lambda.LoggingFormat.JSON,
    });

    // 6. Permissions & Event Source
    queue.grantConsumeMessages(lambdaFunction);
    deliveryStream.grantPutRecords(lambdaFunction);

    lambdaFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(queue, {
        batchSize: 5,
        reportBatchItemFailures: true,
      })
    );
  }
}
```

</details>

---

## CloudWatch Monitoring

In production, we configure **8 alarms** with SNS notifications.

### Alarm List

| Category | Alarm | Threshold | Purpose |
| -------- | -------- | --------- | ---- |
| **SQS** | ApproximateAgeOfOldestMessage | 300s | Detect message backlog |
| **SQS** | NumberOfEmptyReceives | 100 | Detect Long Polling issues |
| **DLQ** | ApproximateNumberOfMessagesVisible | 1 | Immediate failure detection |
| **Firehose** | DeliveryToS3.DataFreshness | 900s | Detect delivery delays |
| **Firehose** | ThrottledRecords | 1 | Detect throttling |
| **Firehose** | IncomingBytes Rate | 80% | Quota utilization |
| **Firehose** | IncomingRecords Rate | 80% | Quota utilization |
| **Firehose** | IncomingPutRequests Rate | 80% | Quota utilization |

### DLQ Alarm (Most Critical)

```typescript
const dlqAlarm = deadLetterQueue
  .metricApproximateNumberOfMessagesVisible()
  .createAlarm(this, 'DlqAlarm', {
    threshold: 1,  // Alert even with 1 message
    evaluationPeriods: 1,
  });
```

### Firehose Quota Monitoring (Math Expression)

```typescript
const incomingBytesRateAlarm = new cw.Alarm(this, 'IncomingBytesRateAlarm', {
  threshold: 80, // Alert at 80% usage
  metric: new cw.MathExpression({
    expression: '100*(m1/300/m2)',  // Calculate usage as %
    usingMetrics: {
      m1: firehose.metric('IncomingBytes', { statistic: 'Sum' }),
      m2: firehose.metric('BytesPerSecondLimit', { statistic: 'Minimum' }),
    },
  }),
});
```

<details>
<summary>📝 SNS Notification Integration Code</summary>

```typescript
const topic = new sns.Topic(this, 'AlertTopic', {
  displayName: 'SQS-Firehose Alerts',
});

[dlqAlarm, sqsAgeAlarm, firehoseFreshnessAlarm, ...otherAlarms].forEach(alarm => {
  alarm.addAlarmAction(new cw_actions.SnsAction(topic));
});
```

</details>

---

## Deployment & Verification

```bash
npm run stage:deploy:all -w workspaces/sqs-lambda-firehose --project=myproject --env=dev

# Send test messages
./test-scripts/send-messages.sh --env dev --project myproject

# Verify data is saved in S3
./test-scripts/check-s3.sh --env dev --project myproject
```

---

## Best Practices Summary

| Component | Recommended | Avoid |
| --------------- | ------ | ------------ |
| SQS | Long Polling, DLQ configuration, SSL enforcement | Short Polling, no DLQ |
| Lambda | ReportBatchItemFailures, appropriate batch size (5-10) | Too large batches, no error handling |
| Firehose | Partitioning, 1-5MB buffer | No partitioning, excessively long buffer time |
| S3 | Lifecycle management, encryption | No lifecycle, public access |

---

## Cost Estimation

<details>
<summary>💰 Monthly Estimate (Tokyo Region, Low-to-Medium Usage)</summary>

| Service | Usage | Monthly Cost |
| -------- | ------ | -------- |
| SQS | 1M requests | $0.40 |
| Lambda | 1M requests, 256MB | $0.83 |
| Firehose | 1GB delivery | $0.03 |
| S3 | 10GB~60GB | $0.50~1.00 |
| CloudWatch | 5GB Logs | $0.27 |

Total: ~$7-10/month

</details>

---

## Summary

What we learned from this pattern:

1. SQS + DLQ: Reliable message processing
2. ReportBatchItemFailures: Efficient handling of partial failures
3. Firehose Partitioning: Analytics-friendly data storage
4. CloudWatch Alarms: Essential monitoring for production

---

## References

- [Amazon SQS Developer Guide](https://docs.aws.amazon.com/sqs/)
- [AWS Lambda Powertools](https://docs.powertools.aws.dev/lambda/python/)
- [Firehose Monitoring Best Practices](https://docs.aws.amazon.com/firehose/latest/dev/firehose-cloudwatch-metrics-best-practices.html)
