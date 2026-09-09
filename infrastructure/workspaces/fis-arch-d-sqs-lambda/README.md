# FIS Chaos Engineering — Architecture D: SQS + Lambda Event-Driven Consumer

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20SQS%20%7C%20Lambda%20%7C%20DynamoDB-orange?style=flat-square)

## Introduction

This project is a reference implementation for AWS Fault Injection Simulator (FIS) chaos engineering on an **SQS + Lambda event-driven consumer** architecture. A Producer Lambda (behind a Function URL) accepts demo load and sends messages to an SQS main queue; a Consumer Lambda drains that queue via an SQS event source mapping and writes processed records to DynamoDB. Unprocessed messages redrive to a dead-letter queue (DLQ) after repeated failed receives.

Three FIS experiment templates manipulate the Consumer Lambda's reserved concurrency to simulate a stalled or degraded consumer — the realistic failure mode operators need to validate before production:

| Scenario | Fault Injected | Duration | What It Validates |
| -------- | --------------- | -------- | ------------------ |
| **D-1** Consumer Outage — short | `ConcurrentExecutions='0'` | 5 min | Message redelivery within the 60s visibility timeout; clean backlog drain once concurrency is restored |
| **D-2** Consumer Outage — long (DLQ) | `ConcurrentExecutions='0'` | 20 min | DLQ routing is guaranteed (20 min ≫ visibilityTimeout×maxReceiveCount = 180s); DLQ alarming and replay procedure |
| **D-3** Throughput Collapse | `ConcurrentExecutions='1'` | 10 min | Queue backlog growth and latency under severe but non-zero throughput degradation |

All experiments share a CloudWatch Alarm stop condition that automatically halts the experiment if the SQS main queue's visible message count exceeds 1000, providing a safety net against unbounded backlog growth.

## Architecture Overview

![Architecture Overview](docs/architecture.html)

```
Operator (curl / shell loop)
    │  POST (IAM-signed)
    ▼
Producer Lambda  (Function URL, AWS_IAM auth, Python 3.13)
    │  sqs:SendMessage
    ▼
SQS Main Queue  (visibilityTimeout=60s, maxReceiveCount=3 → DLQ)
    │  event source mapping, batchSize=5, ReportBatchItemFailures
    ▼
Consumer Lambda  (Python 3.13)
    │  dynamodb:PutItem
    ▼
DynamoDB Table  (PAY_PER_REQUEST, string partition key: id)

SQS Main Queue ──(after 3 failed/unprocessed receives)──► DLQ (retention 14d)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIS Experiment Templates (FisStack)

D-1  aws:lambda:put-function-concurrent-executions ──► Consumer Lambda
     ConcurrentExecutions='0', PT5M   (short outage, no DLQ routing)

D-2  aws:lambda:put-function-concurrent-executions ──► Consumer Lambda
     ConcurrentExecutions='0', PT20M  (long outage, DLQ routing guaranteed)

D-3  aws:lambda:put-function-concurrent-executions ──► Consumer Lambda
     ConcurrentExecutions='1', PT10M  (throughput collapse, no outage)
```

### Why concurrency-only? (design decision)

FIS's `aws:fis:inject-api-internal-error` and `aws:fis:inject-api-throttle-error` actions — the mechanism Architecture B uses against DynamoDB — only accept `service: 'ec2'` or `service: 'kinesis'` as of this writing. **SQS and DynamoDB are not supported service values for these actions**, so there is no supported way to have FIS directly inject `ReceiveMessage`/`SendMessage`/`PutItem` API errors into this pipeline. A Lambda-extension-based approach (`invocation-error` / `invocation-add-delay`) exists in principle, but its exact setup — the required S3 layer bucket structure and environment variable names — could not be confirmed from primary AWS documentation, so it is deliberately **not used** here to avoid shipping a reference implementation built on guessed configuration.

Instead, every scenario in this workspace uses `aws:lambda:put-function-concurrent-executions` — the same action proven reliable in `fis-arch-b-apigw-lambda` — against the **Consumer Lambda's reserved concurrency**. This is not a compromise so much as a better fit for what operators actually need to validate in an SQS+Lambda pipeline: what happens when the consumer *stops processing* (matches a bad deploy, a downstream outage, or a bug that crashes on every invocation) or *processes far slower than normal* (matches resource exhaustion or a noisy-neighbor throttling scenario). Both are consumer-side failure modes, and reserved concurrency is a direct, supported lever for reproducing them without needing FIS to understand SQS or DynamoDB semantics at all.

### Key Design Benefits

| Feature | Benefit |
| ------- | ------- |
| No VPC required | Fully serverless — no NAT Gateway, no subnet planning, no VPC hourly charges |
| Concurrency-only FIS actions | Uses only the one FIS Lambda action with a confirmed, documented contract — no speculative Lambda-extension configuration |
| D-1 vs. D-2 duration split | A 5-minute outage (recoverable within queue redelivery) vs. a 20-minute outage (deterministically drives messages to the DLQ) — the same fault, two blast radii |
| D-3 partial degradation | Reserved concurrency of 1 (not 0) tests a more realistic "slow, not dead" consumer — a scenario a hard outage test alone would miss |
| Shared stop condition | One CloudWatch Alarm (SQS backlog ≥ 1000 visible messages) halts any of the three experiments automatically |
| Function URL producer | No API Gateway needed just to drive demo load — a single IAM-signed POST is enough |

## Prerequisites

- AWS CLI v2 installed and configured
- Node.js 20 or later
- AWS CDK CLI (`npm install -g aws-cdk`)
- Basic knowledge of TypeScript and Python
- AWS account with FIS service-linked role created (auto-created on first FIS use)

> **No VPC or NAT Gateway costs**: this architecture uses only serverless services. The dominant ongoing cost at rest is zero (DynamoDB PAY_PER_REQUEST, SQS/Lambda pay-per-use).

## Project Directory Structure

```text
fis-arch-d-sqs-lambda/
├── bin/
│   └── fis-arch-d-sqs-lambda.ts          # App entry point (Stage instantiation)
├── lambda/
│   ├── consumer/
│   │   └── index.py                       # Python 3.13 SQS → DynamoDB consumer
│   └── producer/
│       └── index.py                       # Python 3.13 Function URL → SQS producer
├── lib/
│   ├── stages/
│   │   └── fis-chaos-stage.ts             # Stage: BaseStack → AppStack → FisStack
│   └── stacks/
│       ├── base-stack.ts                  # DynamoDB table + SQS main queue + DLQ
│       ├── app-stack.ts                   # Consumer Lambda (SQS event source) + Producer Lambda (Function URL)
│       └── fis-stack.ts                   # 3 FIS experiment templates + IAM + alarm
├── parameters/
│   ├── environments.ts                    # Environment parameter type
│   ├── dev-params.ts                      # Development environment parameters
│   └── index.ts                           # Parameter exports
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts               # cdk-nag AwsSolutions compliance checks
│   └── snapshot/
│       └── snapshot.test.ts              # CDK snapshot tests (21 test cases)
├── docs/
│   └── architecture.html                 # Interactive SVG architecture diagram
├── overview.drawio.svg                   # Standalone architecture diagram (SQS/Lambda/DynamoDB + FIS)
├── cdk.json
├── package.json
└── tsconfig.json
```

## Data Flow

```text
Operator (shell loop / curl)
  │  HTTPS POST, SigV4-signed
  ▼
Producer Lambda Function URL  (AuthType: AWS_IAM)
  │  sqs.send_message(QueueUrl=..., MessageBody=<request body or generated demo payload>)
  ▼
SQS Main Queue
  │  event source mapping — batchSize=5, reportBatchItemFailures=true
  ▼
Consumer Lambda (Python 3.13)
  └── for each message in the batch: table.put_item({id, body, processedAt, ...})
        on failure: messageId is returned in batchItemFailures so only that
        message becomes visible again — the rest of the batch is not retried
  ▼
DynamoDB Table  (partition key: id = SQS messageId)

SQS Main Queue ── after 3 failed/unprocessed receives ──► DLQ (14-day retention)
```

### FIS Injection Point

`aws:lambda:put-function-concurrent-executions` sets the **reserved concurrency** of the Consumer Lambda function directly — a control-plane operation, not a code change. At `ConcurrentExecutions='0'` every invocation attempt immediately fails with `TooManyRequestsException` without executing; SQS's own retry/backoff behavior then keeps redelivering the message once its visibility timeout elapses. At `ConcurrentExecutions='1'` the consumer keeps working, just serialized to one message batch at a time. Because the queue and DLQ config never change, the redrive math (`visibilityTimeout × maxReceiveCount = 60s × 3 = 180s`) is the same constant regardless of which scenario is running — only the experiment duration determines whether that threshold is crossed.

## Key Components and Design Points

| Component | Design Points |
| --------- | -------------- |
| DynamoDB Table | PAY_PER_REQUEST billing; costs zero at rest; PITR disabled for minimal cost during experiments |
| SQS Main Queue | `visibilityTimeout=60s`, `retentionPeriod=4 days`, `enforceSSL=true`, redrive policy → DLQ at `maxReceiveCount=3` |
| SQS Dead-Letter Queue | `retentionPeriod=14 days`, `enforceSSL=true` — the terminal point of the redrive chain, intentionally has no DLQ of its own |
| Consumer Lambda | Python 3.13, 256 MB, 30 s timeout; SQS event source with `batchSize=5` and `reportBatchItemFailures=true` (partial batch failure reporting) |
| Producer Lambda | Python 3.13, 128 MB, 10 s timeout; Function URL with `AuthType: AWS_IAM` (not public) |
| FIS IAM Role | Minimal: `lambda:PutFunctionConcurrency` + `lambda:DeleteFunctionConcurrency` on the Consumer Lambda ARN; `cloudwatch:DescribeAlarms` on the stop-condition alarm |
| CloudWatch Stop Alarm | `ApproximateNumberOfMessagesVisible >= 1000` on the main queue — shared by all 3 templates |
| FIS Log Group | `/fis/{project}-{env}-d` — ONE_MONTH retention, auto-deleted on stack destroy |

## Implementation Highlights

### 1. Consumer Lambda uses partial batch failure reporting

The consumer processes each SQS message independently and reports only the messages that actually failed, so a single bad message does not force the whole batch back onto the queue:

```python
# lambda/consumer/index.py (excerpt)
def handler(event, context):
    records = event.get("Records", [])
    batch_item_failures = []

    for record in records:
        try:
            process_message(record)
        except Exception as e:
            batch_item_failures.append({"itemIdentifier": record["messageId"]})

    return {"batchItemFailures": batch_item_failures}
```

```typescript
// lib/stacks/app-stack.ts (excerpt)
this.consumerFunction.addEventSource(
    new lambdaEventSources.SqsEventSource(props.queue, {
        batchSize: 5,
        reportBatchItemFailures: true,
    }),
);
```

### 2. The DLQ redrive math is what makes D-1 and D-2 test different things

```typescript
// lib/stacks/base-stack.ts (excerpt)
this.queue = new sqs.Queue(this, 'MainQueue', {
    visibilityTimeout: cdk.Duration.seconds(60),
    deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
    },
    // ...
});
```

`visibilityTimeout (60s) × maxReceiveCount (3) = 180s` is the maximum time a message can circulate before landing in the DLQ. D-1's 5-minute (300s) outage duration is deliberately close to — and beyond — that threshold to test the *recovery* path once concurrency comes back, while D-2's 20-minute (1200s) outage duration is deliberately far beyond it, so DLQ routing is not a possibility to check for but a guaranteed outcome to verify.

### 3. FIS actions target the Consumer Lambda's reserved concurrency directly

```typescript
// lib/stacks/fis-stack.ts (excerpt — scenario D-2)
targets: {
    ConsumerFunction: {
        resourceType: 'aws:lambda:function',
        resourceArns: [props.consumerFunction.functionArn],
        selectionMode: 'ALL',
    },
},
actions: {
    SetConcurrencyZero: {
        actionId: 'aws:lambda:put-function-concurrent-executions',
        parameters: {
            ConcurrentExecutions: '0',
            duration: 'PT20M',
        },
        targets: { Functions: 'ConsumerFunction' },
    },
},
```

All three scenarios (D-1, D-2, D-3) use this exact same action ID — only `ConcurrentExecutions` (`'0'` vs `'1'`) and `duration` (`PT5M` / `PT20M` / `PT10M`) differ between them. This uniformity is a direct consequence of the "why concurrency-only" design decision above: rather than reaching for unsupported or unverified FIS actions, the same proven action is parameterized three different ways to cover three distinct operational failure modes.

### 4. Shared stop condition on queue backlog, not Lambda errors

Unlike Architecture B (which alarms on Lambda error count), Architecture D alarms on **queue depth** — because during D-1 and D-2 the Consumer Lambda is not running at all, so it cannot emit error metrics. The queue backlog is the correct signal to watch:

```typescript
const queueBacklogAlarm = new cw.Alarm(this, 'QueueBacklogAlarm', {
    metric: props.queue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
    }),
    threshold: 1000,
    evaluationPeriods: 1,
    comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cw.TreatMissingData.NOT_BREACHING,
});

const stopConditions = [{
    source: 'aws:cloudwatch:alarm',
    value: queueBacklogAlarm.alarmArn,
}];
```

If message backlog exceeds the safety threshold, FIS stops the experiment and the Consumer Lambda's reserved concurrency is removed (returning it to unreserved/account-pool concurrency). The alarm also sends a notification to the SNS topic (with optional email subscription via the `alarmEmail` parameter).

### 5. Producer Lambda exists purely to drive demo load

```python
# lambda/producer/index.py (excerpt)
def handler(event, context):
    body = event.get("body") or json.dumps({"id": str(uuid.uuid4()), "message": "demo load"})
    result = sqs.send_message(QueueUrl=QUEUE_URL, MessageBody=body)
    return response(202, {"messageId": result["MessageId"]})
```

The Function URL uses `AuthType: AWS_IAM` (SigV4-signed requests only) rather than a public endpoint, so demo load generation still requires valid AWS credentials — appropriate for a chaos-engineering test harness that is not meant to accept arbitrary public traffic.

## Deployment Guide

### 1. Install dependencies

```bash
cd infrastructure
npm ci
```

### 2. Configure environment parameters

Edit `parameters/dev-params.ts` to set your region and optionally an alarm email:

```typescript
// parameters/dev-params.ts
export const devParams: EnvParams = {
    region: 'ap-northeast-1',
    // alarmEmail: 'ops@example.com',  // uncomment to receive alarm notifications
};
```

### 3. Bootstrap CDK (first time only)

```bash
PROJECT=fis-chaos-d ENV=dev npm run bootstrap
```

### 4. Deploy all stacks

```bash
PROJECT=fis-chaos-d ENV=dev npm run stage:deploy:all
```

This deploys the three stacks in dependency order:
1. `fis-chaos-d-dev-d-base` — DynamoDB table + SQS main queue + DLQ
2. `fis-chaos-d-dev-d-app` — Consumer Lambda (SQS event source) + Producer Lambda (Function URL)
3. `fis-chaos-d-dev-d-fis` — FIS templates + IAM + alarm

### 5. Drive demo load

After deployment, retrieve the Producer Function URL from the stack output and send SigV4-signed requests (the Function URL requires IAM auth, so plain `curl` without credentials will be rejected):

```bash
# Send a single demo message
aws lambda invoke --function-name fis-chaos-d-dev-producer \
  --payload '{"body":"{\"hello\":\"world\"}"}' /tmp/out.json

# Or use `awscurl` (SigV4-signing curl wrapper) against the Function URL for a loop:
for i in $(seq 1 50); do
  awscurl --service lambda -X POST "<function-url>" -d "{\"n\":$i}"
done
```

### 6. Run a FIS experiment

Navigate to the AWS FIS console, select one of the three experiment templates (`D-1`, `D-2`, `D-3`), click **Start experiment**, and watch the SQS main queue's `ApproximateNumberOfMessagesVisible` metric (and, for D-2, the DLQ's message count) in CloudWatch while demo load continues arriving.

## Testing

```bash
cd infrastructure
npm ci

# Run all tests for this workspace
npm run test --workspace=fis-arch-d-sqs-lambda

# Snapshot tests only (21 test cases across 3 stacks)
npm run test:snapshot --workspace=fis-arch-d-sqs-lambda

# CDK Nag compliance checks
npm run test:compliance --workspace=fis-arch-d-sqs-lambda

# Update snapshots after intentional changes
npm run test:snapshot:update --workspace=fis-arch-d-sqs-lambda
```

### What the tests cover

| Test suite | File | Assertions |
| ---------- | ---- | ---------- |
| Snapshot | `test/snapshot/snapshot.test.ts` | Full CFn template snapshots for all 3 stacks; DynamoDB PAY_PER_REQUEST; exactly 2 SQS queues with a `maxReceiveCount=3` redrive policy and `VisibilityTimeout=60`; 2 Lambdas on Python 3.13; SQS event source mapping with `BatchSize=5` and `ReportBatchItemFailures`; Function URL with `AWS_IAM` auth; exactly 3 FIS templates, all with stop conditions and all using `aws:lambda:put-function-concurrent-executions` |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutions pack — no unsuppressed warnings or errors |

## Cost Estimation

All services are serverless (pay-per-use), so the cost at rest is effectively **zero**.

| Service | Billing Model | Estimated cost during experiments |
| ------- | -------------- | ---------------------------------- |
| DynamoDB | PAY_PER_REQUEST | ~$0 at idle; <$0.01 for a few hundred test writes |
| SQS | Per request | <$0.01 for a few thousand demo messages |
| Lambda | Per invocation + duration | <$0.01 for a 20-minute experiment at modest demo load |
| CloudWatch | Metrics + logs | ~$0.01/month for experiment logs |
| FIS | Free | No charge for FIS itself |
| **Total (experiments only)** | | **< $0.10 per experiment run** |

## Security Considerations

- **Consumer execution role follows least privilege**: the role only has `dynamodb:PutItem` (and the sub-resource wildcards CDK's `grantWriteData()` generates for index resources) on the specific table, plus the SQS event source's standard `sqs:ReceiveMessage`/`DeleteMessage`/`GetQueueAttributes` grant scoped to the main queue.
- **Producer execution role follows least privilege**: only `sqs:SendMessage` on the main queue, via `queue.grantSendMessages()`.
- **Producer Function URL requires IAM auth**: `AuthType: AWS_IAM` means every request must be SigV4-signed with valid AWS credentials — there is no public, unauthenticated entry point into this pipeline.
- **Both queues enforce TLS**: `enforceSSL: true` denies any non-HTTPS request to either queue.
- **FIS role follows least privilege**: scoped to `lambda:PutFunctionConcurrency` / `lambda:DeleteFunctionConcurrency` on the Consumer Lambda ARN specifically, plus `cloudwatch:DescribeAlarms` on the stop-condition alarm.
- **No VPC exposure**: there is no VPC, no public subnet, and no security group — the only entry point is the IAM-authenticated Function URL.
- **Stop condition is mandatory**: all FIS templates include the queue-backlog alarm stop condition, which limits maximum experiment blast radius (unbounded backlog growth).

## Troubleshooting

| Symptom | Likely cause | Resolution |
| ------- | ------------ | ---------- |
| `cdk deploy` fails with `No parameters found for environment` | Missing `dev-params.ts` export | Verify `parameters/index.ts` imports `./dev-params` and that it registers under the `dev` key |
| Producer Function URL returns 403 | Missing/invalid SigV4 signature | Use `aws lambda invoke`, an SDK, or a SigV4-signing tool (e.g. `awscurl`) — plain unauthenticated `curl` is rejected by design |
| Messages never appear in DynamoDB during D-1/D-2 | Expected — FIS has set reserved concurrency to 0, the consumer cannot execute | Confirm the experiment is running; messages should catch up once it stops (D-1) or land in the DLQ (D-2) |
| FIS experiment stops immediately | Stop condition alarm is already in `ALARM` state | Reset the alarm first (`aws cloudwatch set-alarm-state --alarm-name ... --state-value OK`) |
| DLQ stays empty during D-2 | Not enough messages were in flight during the 20-minute window | Drive continuous demo load into the queue before/during the experiment |
| `Table not found` Lambda error | BaseStack not yet deployed | Deploy stacks in order: Base → App → FIS |

## Clean-up

```bash
PROJECT=fis-chaos-d ENV=dev npm run stage:destroy:all
```

All resources have `removalPolicy: DESTROY`, so the destroy command removes the DynamoDB table, both SQS queues, both Lambda functions, the Function URL, the FIS templates, and the CloudWatch log groups completely.

## Summary

This workspace demonstrates FIS chaos engineering on an event-driven SQS+Lambda consumer architecture, working within a real constraint: FIS has no supported way to inject API-level faults directly into SQS or DynamoDB. Rather than reaching for an unverified workaround, all three scenarios reuse the one FIS Lambda action with a confirmed, documented contract:

- **D-1** verifies the pipeline recovers cleanly from a short consumer outage — messages redeliver and the backlog drains once concurrency is restored.
- **D-2** deliberately drives messages into the DLQ (outage duration ≫ the redrive threshold) to verify DLQ routing, alarming, and replay procedures actually work.
- **D-3** verifies behavior under sustained partial capacity loss — a more realistic "degraded, not dead" failure than a hard outage.

The serverless architecture keeps experiment costs minimal (< $0.10 per run) and eliminates VPC management overhead, making it easy to iterate quickly on resilience scenarios for event-driven consumers.

## References

- [AWS FIS — Supported actions](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [aws:lambda:put-function-concurrent-executions action reference](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-lambda)
- [CDK aws-fis module (L1 constructs)](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_fis-readme.html)
- [Amazon SQS dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [Using Lambda with Amazon SQS (event source mapping, batch item failures)](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)
- [Lambda Function URLs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-urls.html)
