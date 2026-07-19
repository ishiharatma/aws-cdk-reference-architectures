# CloudWatch Logs → S3 Archive — Three Patterns for Log Archiving

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

## Introduction

This project is a reference implementation that uses the AWS CDK to archive CloudWatch Logs to S3.
It covers three distinct archiving patterns as five separate CDK stacks, allowing you to choose the approach that best fits your latency, cost, and operational requirements.

This architecture demonstrates the following implementations:

- **Pattern A** — Real-time streaming via Kinesis Data Firehose (Stacks 1–3)
- **Pattern B** — Scheduled batch export via the CloudWatch Logs Export Task API and Lambda + EventBridge (Stack 4)
- **Pattern C** — Direct write via a CloudWatch Logs subscription filter invoking Lambda (Stack 5)

### Why Three Patterns?

| Feature | Pattern A (Firehose) | Pattern B (Export Task) | Pattern C (Lambda) |
| ------- | -------------------- | ----------------------- | ------------------- |
| Delivery latency | Near-real-time (seconds–minutes) | Scheduled (up to 12 h delay) | Near-real-time |
| Cost at scale | Moderate (Firehose + S3) | Low (Lambda + S3 only) | Moderate (Lambda invocations) |
| Output format | Raw CWL JSON lines, GZIP | Raw CWL format | Custom JSON (fully controllable) |
| Operational simplicity | High (managed Firehose) | High (managed Export API) | Low (Lambda code to maintain) |
| Custom transform | Limited (Firehose data transformation) | None | Full control in Lambda |

## Architecture Overview

### Pattern A — Kinesis Data Firehose (Stacks 1, 2, 3)

```text
CloudWatch Log Group
  → Subscription Filter  (CfnSubscriptionFilter, roleArn = CwlToFirehoseRole)
  → Kinesis Data Firehose (GZIP compression, date-partitioned prefix)
  → S3 Archive Bucket
```

Three stacks illustrate increasing S3 lifecycle complexity and the "existing log group" use case:

| Stack | Description |
| ----- | ----------- |
| **Basic** (Stack 1) | New log group, minimal lifecycle (abort multipart + expire non-current versions) |
| **Lifecycle** (Stack 2) | Same as Basic + tiered transitions: Standard → IA (30 d) → Glacier IR (90 d) → Deep Archive (365 d) → Expire (7 yr) |
| **Existing** (Stack 3) | Attaches a Firehose subscription to a pre-existing log group (imported by name) |

### Pattern B — Scheduled Export Task (Stack 4)

```text
EventBridge Rule (schedule)
  → Lambda  (calls logs:CreateExportTask for the previous day)
  → CloudWatch Logs Export API
  → S3 Archive Bucket  (bucket policy allows logs.amazonaws.com to write)
```

### Pattern C — Subscription Filter → Lambda → S3 (Stack 5)

```text
CloudWatch Log Group
  → Subscription Filter  (LambdaDestination, CDK manages invoke permission)
  → Lambda  (decodes gzip+base64 CWL payload, writes JSON to S3)
  → S3 Archive Bucket
```

---

## Prerequisites

- AWS CLI v2 installed and configured
- Node.js 20+
- AWS CDK CLI (`npm install -g aws-cdk`)
- Basic TypeScript knowledge
- AWS account
- AWS CLI profile configuration for target accounts

## Project Directory Structure

```text
cloudwatch-logs-s3-archive/
├── bin/
│   └── cloudwatch-logs-s3-archive.ts          # Application entry point
├── lib/
│   ├── stacks/
│   │   ├── cloudwatch-logs-s3-archive-basic-stack.ts     # Stack 1 – Pattern A Basic
│   │   ├── cloudwatch-logs-s3-archive-lifecycle-stack.ts # Stack 2 – Pattern A Lifecycle
│   │   ├── cloudwatch-logs-s3-archive-existing-stack.ts  # Stack 3 – Pattern A Existing LG
│   │   ├── cloudwatch-logs-s3-archive-export-stack.ts    # Stack 4 – Pattern B Export Task
│   │   └── cloudwatch-logs-s3-archive-lambda-stack.ts    # Stack 5 – Pattern C Lambda
│   ├── stages/
│   │   └── cloudwatch-logs-s3-archive-stage.ts           # Deployment orchestration
│   └── types/
│       ├── index.ts                            # Type exports
│       ├── firehose-params.ts                  # Firehose parameter types
│       ├── log-group-params.ts                 # Log group parameter types
│       ├── lifecycle-params.ts                 # Lifecycle parameter types
│       ├── export-task-params.ts               # Export task parameter types
│       └── lambda-archive-params.ts            # Lambda archive parameter types
├── parameters/
│   ├── environments.ts                         # EnvParams interface + registry
│   ├── dev-params.ts                           # Development environment parameters
│   └── prd-params.ts                           # Production environment parameters
├── src/
│   └── lambda/
│       ├── export-task/
│       │   └── index.py                        # Pattern B – CreateExportTask handler
│       └── cwl-to-s3/
│           └── index.py                        # Pattern C – CWL payload → S3 writer
└── test/
    ├── compliance/
    │   └── cdk-nag.test.ts                     # CDK Nag AwsSolutions compliance tests
    ├── snapshot/
    │   └── snapshot.test.ts                    # CloudFormation template snapshot tests
    └── unit/
        └── cloudwatch-logs-s3-archive.test.ts  # Fine-grained assertion tests
```

---

## Implementation Highlights

### 1. Pattern A — Kinesis Data Firehose Subscription

CloudWatch Logs cannot deliver to Firehose without an explicit IAM role. Two roles are required:

- **CwlToFirehoseRole** — assumed by `logs.amazonaws.com`; grants `firehose:PutRecord` and `firehose:PutRecordBatch` scoped to the specific delivery stream and log group via `SourceArn` conditions.
- **FirehoseRole** — assumed by `firehose.amazonaws.com`; grants S3 write permissions on the archive bucket.

```typescript
// CWL → Firehose trust + policy
const cwlToFirehoseRole = new iam.Role(this, 'CwlToFirehoseRole', {
    assumedBy: new iam.ServicePrincipal('logs.amazonaws.com', {
        conditions: {
            ArnLike: { 'aws:SourceArn': this.logGroup.logGroupArn },
        },
    }),
});
cwlToFirehoseRole.addToPolicy(new iam.PolicyStatement({
    actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
    resources: [deliveryStream.deliveryStreamArn],
}));

// Subscription filter (L1 used so roleArn can be supplied explicitly)
new logs.CfnSubscriptionFilter(this, 'SubscriptionFilter', {
    logGroupName: this.logGroup.logGroupName,
    destinationArn: deliveryStream.deliveryStreamArn,
    filterPattern: filterPattern,
    roleArn: cwlToFirehoseRole.roleArn,
});
```

> **Why `CfnSubscriptionFilter` instead of the L2 `SubscriptionFilter`?**
> The L2 construct does not expose a `roleArn` parameter.  For a Firehose destination the role ARN is mandatory, so the L1 resource must be used.

### 2. Tiered S3 Lifecycle (Stack 2 – Lifecycle)

Long-term archives benefit from moving infrequently accessed data to cheaper storage classes.

```typescript
bucket.addLifecycleRule({
    transitions: [
        { storageClass: s3.StorageClass.INFREQUENT_ACCESS,       transitionAfter: cdk.Duration.days(30)  },
        { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: cdk.Duration.days(90)  },
        { storageClass: s3.StorageClass.DEEP_ARCHIVE,             transitionAfter: cdk.Duration.days(365) },
    ],
    expiration: cdk.Duration.days(2555),  // 7 years
    noncurrentVersionTransitions: [
        { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(30) },
    ],
    noncurrentVersionExpiration: cdk.Duration.days(90),
    noncurrentVersionsToRetain: 3,
    abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
});
```

### 3. Pattern B — Scheduled Export Task

The CloudWatch Logs Export Task API imposes a **one-task-at-a-time** limit per account.  The Lambda checks for running tasks before submitting a new one to avoid errors.

```python
# export-task/index.py (key logic)
def lambda_handler(event, context):
    # Skip if another task is already running
    running = logs.describe_export_tasks(statusCode='RUNNING')
    if running['exportTasks']:
        return {'statusCode': 409, 'body': 'Export task already running'}

    # Export the previous day's logs
    now = datetime.utcnow()
    start = int(datetime(now.year, now.month, now.day).timestamp() * 1000) - 86400000
    end   = start + 86399999

    response = logs.create_export_task(
        logGroupName=LOG_GROUP_NAME,
        fromTime=start,
        to=end,
        destination=S3_BUCKET_NAME,
        destinationPrefix=f"{S3_PREFIX}/{now.strftime('%Y/%m/%d')}",
    )
    return {'statusCode': 200, 'taskId': response['taskId']}
```

The S3 bucket requires two resource policy statements to allow the CloudWatch Logs service to write:

```typescript
// 1. Allow CWL to check the bucket ACL before exporting
bucket.addToResourcePolicy(new iam.PolicyStatement({
    principals: [new iam.ServicePrincipal('logs.amazonaws.com')],
    actions: ['s3:GetBucketAcl'],
    resources: [bucket.bucketArn],
    conditions: { ArnLike: { 'aws:SourceArn': `arn:${partition}:logs:${region}:${account}:log-group:*` } },
}));

// 2. Allow CWL to write exported objects
bucket.addToResourcePolicy(new iam.PolicyStatement({
    principals: [new iam.ServicePrincipal('logs.amazonaws.com')],
    actions: ['s3:PutObject'],
    resources: [bucket.arnForObjects('*')],
    conditions: {
        StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control' },
        ArnLike: { 'aws:SourceArn': `arn:${partition}:logs:${region}:${account}:log-group:*` },
    },
}));
```

### 4. Pattern C — Subscription Filter → Lambda → S3

`LambdaDestination` automatically creates the Lambda resource policy allowing `logs.amazonaws.com` to invoke the function, so no manual `Lambda::Permission` resource is needed.

```typescript
new logs.SubscriptionFilter(this, 'CwlSubscriptionFilter', {
    logGroup: this.logGroup,
    destination: new logDestinations.LambdaDestination(this.archiveFunction),
    filterPattern: filterPattern
        ? logs.FilterPattern.literal(filterPattern)
        : logs.FilterPattern.allEvents(),
});
```

The Lambda decodes the compressed payload and writes a JSON file per invocation:

```python
# cwl-to-s3/index.py (key logic)
def lambda_handler(event, context):
    compressed = base64.b64decode(event['awslogs']['data'])
    payload    = json.loads(gzip.decompress(compressed))

    key = (
        f"{S3_PREFIX}/"
        f"{datetime.utcnow().strftime('%Y/%m/%d/%H')}/"
        f"{payload['logGroup'].lstrip('/')}/"
        f"{payload['logStream']}/"
        f"{context.aws_request_id}.json"
    )
    s3.put_object(Bucket=S3_BUCKET_NAME, Key=key, Body=json.dumps(payload))
```

---

## Key Components and Design Points

| Component | Design Point |
| --------- | ------------ |
| **S3 Bucket** | SSE-S3 encryption, versioning enabled, public access blocked, SSL enforced |
| **CwlToFirehoseRole** | `SourceArn` condition scopes trust to the specific log group |
| **FirehoseRole** | Grants `s3:PutObject` on `bucket/*`; wildcard is intentional and required for Firehose |
| **Lifecycle rules** | Abort incomplete multipart (7 d) and expire non-current versions (90 d, keep 3) applied to all stacks |
| **Tiered lifecycle** | Stack 2 adds Standard→IA→Glacier IR→Deep Archive→Expire transitions for cost optimization |
| **Import existing LG** | Stack 3 uses `LogGroup.fromLogGroupName()` — no `AWS::Logs::LogGroup` resource is created |
| **Export Task** | Single-concurrency guard in Lambda; bucket policy grants CWL service principal write access |
| **LambdaDestination** | CDK L2 automatically manages the `Lambda::Permission` resource for CWL invoke |

---

## Deployment & Verification

```bash
# Bootstrap (first time only)
npx cdk bootstrap --profile <your-profile>

# Deploy all stacks
npm run stage:deploy:all -w workspaces/cloudwatch-logs-s3-archive -- --project=myproject --env=dev

# Deploy individual stacks
npm run stage:deploy -w workspaces/cloudwatch-logs-s3-archive -- --project=myproject --env=dev --stack=basic
npm run stage:deploy -w workspaces/cloudwatch-logs-s3-archive -- --project=myproject --env=dev --stack=export
npm run stage:deploy -w workspaces/cloudwatch-logs-s3-archive -- --project=myproject --env=dev --stack=lambda
```

### Verify Pattern A (Firehose)

```bash
# Write a test log entry
aws logs put-log-events \
  --log-group-name /<project>/<env>/app \
  --log-stream-name test-stream \
  --log-events timestamp=$(date +%s000),message="hello firehose"

# After ~60 seconds, check the archive bucket
aws s3 ls s3://<archive-bucket>/ --recursive
```

### Verify Pattern B (Export Task)

```bash
# Invoke the export Lambda manually
aws lambda invoke \
  --function-name <project>-<env>-cwl-export-task \
  --payload '{}' response.json
cat response.json
```

### Verify Pattern C (Lambda)

```bash
# Write a test log entry; the subscription filter triggers the Lambda immediately
aws logs put-log-events \
  --log-group-name /<project>/<env>/app-lambda \
  --log-stream-name test-stream \
  --log-events timestamp=$(date +%s000),message="hello lambda"

aws s3 ls s3://<archive-bucket>/subscriptions/ --recursive
```

---

## Running Tests

```bash
# Unit tests (fine-grained CDK assertions)
npm run test:unit -w cloudwatch-logs-s3-archive

# Snapshot tests
npm run test:snapshot -w cloudwatch-logs-s3-archive

# CDK Nag compliance (AwsSolutions pack)
npm run test:compliance -w cloudwatch-logs-s3-archive
```

---

## Best Practices Summary

| Component | Recommended | Avoid |
| --------- | ----------- | ----- |
| Pattern A IAM | Two separate roles (CWL→Firehose, Firehose→S3) with `SourceArn` conditions | Single role with overly broad trust |
| Pattern A subscription | L1 `CfnSubscriptionFilter` with explicit `roleArn` | L2 `SubscriptionFilter` (no `roleArn` support for Firehose) |
| Pattern B concurrency | Check for running tasks before calling `CreateExportTask` | Fire-and-forget (risks `LimitExceededException`) |
| Pattern B bucket policy | Scope `aws:SourceArn` to your account's log groups | Omit conditions (allows any CWL principal to write) |
| Pattern C destination | `LambdaDestination` (CDK manages invoke permission automatically) | Manual `Lambda::Permission` resource |
| S3 security | `enforceSSL: true`, `blockPublicAccess: BLOCK_ALL`, `encryption: S3_MANAGED` | Default bucket settings |
| Lifecycle | Abort incomplete multipart uploads (7 d) on every bucket | No lifecycle rule (accumulates incomplete parts) |

---

## Cost Estimation

<details>
<summary>💰 Monthly Estimate (Tokyo Region, 1 GB/day of log data)</summary>

| Service | Pattern | Monthly Cost |
| ------- | ------- | ------------ |
| Kinesis Data Firehose | A | ~$0.03/GB → ~$0.90 |
| Lambda | B, C | Negligible at low invocation counts |
| S3 (Standard) | All | ~$0.025/GB-month → ~$0.75 |
| CloudWatch Logs | All | ~$0.76/GB ingestion |
| EventBridge | B | $1.00 per million events (minimal) |

Total (Pattern A): ~$2–3/month for 1 GB/day log volume

</details>

---

## Summary

What we learned from this pattern:

1. **Pattern A (Firehose)**: Best for near-real-time archiving with minimal code; requires two IAM roles and L1 `CfnSubscriptionFilter`.
2. **Pattern B (Export Task)**: Lowest cost for batch use cases; limited to one concurrent task per account; bucket policy must explicitly grant write access to `logs.amazonaws.com`.
3. **Pattern C (Lambda)**: Maximum flexibility for custom output formats; `LambdaDestination` simplifies invoke permissions; manage Lambda concurrency carefully for high-throughput log groups.

---

## References

- [CloudWatch Logs Subscriptions](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/Subscriptions.html)
- [CloudWatch Logs Export to S3](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/S3Export.html)
- [Kinesis Data Firehose Developer Guide](https://docs.aws.amazon.com/firehose/latest/dev/what-is-this-service.html)
- [S3 Lifecycle Configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
- [CDK Nag AwsSolutions Rules](https://github.com/cdklabs/cdk-nag/blob/main/RULES.md)
