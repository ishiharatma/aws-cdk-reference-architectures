# FIS Chaos Engineering — Architecture D: SQS + Lambda Event-Driven Consumer

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20SQS%20%7C%20Lambda%20%7C%20DynamoDB-orange?style=flat-square)

## Introduction

This project is a reference implementation for AWS Fault Injection Simulator (FIS) chaos engineering on an **SQS + Lambda event-driven consumer** architecture. A Producer Lambda (behind a Function URL) accepts demo load and sends messages to an SQS main queue; a Consumer Lambda drains that queue via an SQS event source mapping and writes processed records to DynamoDB. Unprocessed messages redrive to a dead-letter queue (DLQ) after repeated failed receives.

Three FIS experiment templates inject faults into the Consumer Lambda using the `aws:lambda:function` action family via the AWS FIS Lambda extension — the same mechanism [Architecture B](../fis-arch-b-apigw-lambda) uses for a serverless API:

| Scenario | Fault Injected | Duration | What It Validates |
| -------- | --------------- | -------- | ------------------ |
| **D-1** Consumer Outage — short | `invocation-error`, `preventExecution=true`, 100% | 5 min | Message redelivery within the 60s visibility timeout; clean backlog drain once the fault clears |
| **D-2** Consumer Outage — long (DLQ) | Same action | 20 min | DLQ routing is guaranteed (20 min ≫ visibilityTimeout×maxReceiveCount = 180s); DLQ alarming and replay procedure |
| **D-3** Throughput Collapse | `invocation-add-delay`, `startupDelayMilliseconds=20000` | 10 min | Queue backlog growth and latency under severe but non-zero throughput degradation |

All experiments share a CloudWatch Alarm stop condition that automatically halts the experiment if the SQS main queue's visible message count exceeds 1000, providing a safety net against unbounded backlog growth.

> ### ⚠️ `aws:lambda:put-function-concurrent-executions` does not exist
> An earlier version of this workspace tried to zero out the Consumer Lambda's reserved concurrency via `aws:lambda:put-function-concurrent-executions`. **That action ID does not exist** — `aws fis list-actions` confirms Lambda-targeted FIS actions are limited to the `aws:lambda:function` family (`invocation-error`, `invocation-add-delay`, `invocation-http-integration-response`). CloudFormation failed FIS template creation outright with `Invalid actionId ... 404`. This was deploy-verified end-to-end after the fix — see [Observed Results](#observed-results-ap-northeast-1).

## Architecture Overview

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
Consumer Lambda  (Python 3.13, + FIS extension layer)
    │  dynamodb:PutItem
    ▼
DynamoDB Table  (PAY_PER_REQUEST, string partition key: id)

SQS Main Queue ──(after 3 failed/unprocessed receives)──► DLQ (retention 14d)

FIS ⇄ extension config exchange:
    S3 bucket  <project>-<env>-d-fis-config-<account>  (prefix FisConfigs/)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIS Experiment Templates (FisStack)   target: aws:lambda:function (Consumer Lambda ARN)

D-1  aws:lambda:invocation-error       preventExecution=true, 100%, PT5M
D-2  aws:lambda:invocation-error       preventExecution=true, 100%, PT20M
D-3  aws:lambda:invocation-add-delay   startupDelayMilliseconds=20000, 100%, PT10M
```

### Key Design Benefits

| Feature | Benefit |
| ------- | ------- |
| No VPC required | Fully serverless — no NAT Gateway, no subnet planning, no VPC hourly charges |
| `aws:lambda:function` actions | FIS injects faults into function invocations through the FIS Lambda extension; the handler code is untouched |
| D-1 vs. D-2 duration split | A 5-minute outage (recoverable within queue redelivery) vs. a 20-minute outage (deterministically drives messages to the DLQ) — the same fault, two blast radii |
| D-3 delay, not zero | A 20s startup delay (not a hard error) tests a more realistic "slow, not dead" consumer — a scenario a hard outage test alone would miss |
| Shared stop condition | One CloudWatch Alarm (SQS backlog ≥ 1000 visible messages) halts any of the three experiments automatically |
| Function URL producer | No API Gateway needed just to drive demo load — a single IAM-signed POST is enough |

## Prerequisites

- AWS CLI v2 installed and configured
- Node.js 20 or later
- AWS CDK CLI (`npm install -g aws-cdk`)
- Basic knowledge of TypeScript and Python
- AWS account with FIS service-linked role created (auto-created on first FIS use)

> **No VPC or NAT Gateway costs**: this architecture uses only serverless services. The dominant ongoing cost at rest is zero (DynamoDB PAY_PER_REQUEST, SQS/Lambda pay-per-use, S3 config bucket near-empty).

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
│       ├── app-stack.ts                   # Consumer Lambda (+ FIS extension layer) + Producer Lambda + FIS config bucket
│       └── fis-stack.ts                   # 3 FIS experiment templates + IAM + alarm
├── parameters/
│   ├── environments.ts                    # Environment parameter type
│   ├── dev-params.ts                      # Development environment parameters
│   └── index.ts                           # Parameter exports
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts               # cdk-nag AwsSolutions compliance checks
│   └── snapshot/
│       └── snapshot.test.ts              # CDK snapshot tests
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
Consumer Lambda (Python 3.13)   ── AWS FIS Lambda extension intercepts the invocation ──►
  └── for each message in the batch: table.put_item({id, body, processedAt, ...})
        on failure: messageId is returned in batchItemFailures so only that
        message becomes visible again — the rest of the batch is not retried
  ▼
DynamoDB Table  (partition key: id = SQS messageId)

SQS Main Queue ── after 3 failed/unprocessed receives ──► DLQ (14-day retention)
```

### FIS Injection Point

The `aws:lambda:function` actions inject faults through the **AWS FIS Lambda extension**, attached to the Consumer Lambda as a layer. When an experiment starts, FIS writes the active fault configuration to an S3 prefix; the extension polls that prefix and applies the fault around the handler invocation — the handler code itself never changes.

- **D-1 / D-2** (`invocation-error`, `preventExecution=true`): every invocation fails *before* the handler runs. SQS's own retry/backoff behavior then keeps redelivering the message once its visibility timeout elapses — functionally the same "consumer cannot run at all" effect the design originally wanted from zeroing reserved concurrency, reached through a real action instead.
- **D-3** (`invocation-add-delay`, `startupDelayMilliseconds=20000`): the handler still runs and still commits its writes, but every invocation is 20s slower — comfortably inside the function's 30s timeout, leaving ~10s for the batch's actual DynamoDB puts.

Because the extension polls rather than pushes, expect up to ~60s of ramp-up before every invocation is affected, and ~20s of ramp-down after the action ends — the same behavior documented for Architecture B.

## Key Components and Design Points

| Component | Design Points |
| --------- | -------------- |
| DynamoDB Table | PAY_PER_REQUEST billing; costs zero at rest; PITR disabled for minimal cost during experiments |
| SQS Main Queue | `visibilityTimeout=60s`, `retentionPeriod=4 days`, `enforceSSL=true`, redrive policy → DLQ at `maxReceiveCount=3` |
| SQS Dead-Letter Queue | `retentionPeriod=14 days`, `enforceSSL=true` — the terminal point of the redrive chain, intentionally has no DLQ of its own |
| Consumer Lambda | Python 3.13, 256 MB, 30s timeout. Carries the FIS extension layer + `AWS_LAMBDA_EXEC_WRAPPER=/opt/aws-fis/bootstrap`, `AWS_FIS_CONFIGURATION_LOCATION=arn:aws:s3:::<bucket>/FisConfigs/`, `AWS_FIS_POLL_MAX_WAIT_MILLISECONDS=2000`. SQS event source with `batchSize=5` and `reportBatchItemFailures=true` |
| Producer Lambda | Python 3.13, 128 MB, 10s timeout; Function URL with `AuthType: AWS_IAM` (not public); no FIS extension (never a fault target) |
| FIS config bucket | `<project>-<env>-d-fis-config-<account>` — S3-managed encryption, all public access blocked, 1-day lifecycle expiry |
| FIS IAM Role | `s3:PutObject`/`s3:DeleteObject` on `<bucket>/FisConfigs/*`; `lambda:GetFunction` and `tag:GetResources` on `*`; `cloudwatch:DescribeAlarms` on the stop-condition alarm |
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

`visibilityTimeout (60s) × maxReceiveCount (3) = 180s` is the maximum time a message can circulate before landing in the DLQ. D-1's 5-minute (300s) outage duration is deliberately close to — and beyond — that threshold to test the *recovery* path once the fault clears, while D-2's 20-minute (1200s) outage duration is deliberately far beyond it, so DLQ routing is not a possibility to check for but a guaranteed outcome to verify.

### 3. The FIS Lambda extension is a hard prerequisite

`aws:lambda:function` actions do not work on a bare function. The one-time setup (all in `app-stack.ts`) mirrors Architecture B:

```typescript
const fisExtensionLayerArn = ssm.StringParameter.valueForStringParameter(
    this, FIS_EXTENSION_LAYER_SSM_PARAM,
);

this.consumerFunction = new lambda.Function(this, 'ConsumerFunction', {
    // ...
    layers: [lambda.LayerVersion.fromLayerVersionArn(this, 'FisExtensionLayer', fisExtensionLayerArn)],
    environment: {
        TABLE_NAME: props.table.tableName,
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/aws-fis/bootstrap',
        AWS_FIS_CONFIGURATION_LOCATION: `arn:aws:s3:::${this.fisConfigBucket.bucketName}/FisConfigs/`,
        AWS_FIS_POLL_MAX_WAIT_MILLISECONDS: '2000',
    },
});
```

```typescript
// lib/stacks/fis-stack.ts (excerpt — scenario D-1)
targets: {
    ConsumerFunction: {
        resourceType: 'aws:lambda:function',
        resourceArns: [props.consumerFunction.functionArn],
        selectionMode: 'ALL',
    },
},
actions: {
    InjectConsumerOutage: {
        actionId: 'aws:lambda:invocation-error',
        parameters: { duration: 'PT5M', invocationPercentage: '100', preventExecution: 'true' },
        targets: { Functions: 'ConsumerFunction' },
    },
},
```

D-1 and D-2 use the identical action and parameters, differing only in `duration`. D-3 swaps to `invocation-add-delay` with `startupDelayMilliseconds`.

### 4. Shared stop condition on queue backlog, not Lambda errors

Unlike Architecture B (which alarms on Lambda error count), Architecture D alarms on **queue depth** — during D-1 and D-2 the Consumer Lambda's invocations fail before doing any work, but the queue backlog is the signal that actually matters operationally:

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

If message backlog exceeds the safety threshold, FIS stops the experiment and the extension's fault clears within its ramp-down window. The alarm also sends a notification to the SNS topic (with optional email subscription via the `alarmEmail` parameter).

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
PROJECT=<project> ENV=dev npm run bootstrap -w workspaces/fis-arch-d-sqs-lambda
```

### 4. Deploy all stacks

```bash
PROJECT=<project> ENV=dev npm run stage:deploy:all -w workspaces/fis-arch-d-sqs-lambda -- --require-approval never
```

This deploys the three stacks in dependency order:
1. `<project>-dev-d-base` — DynamoDB table + SQS main queue + DLQ
2. `<project>-dev-d-app` — Consumer Lambda (+ FIS extension layer) + Producer Lambda + FIS config bucket
3. `<project>-dev-d-fis` — FIS templates + IAM + alarm

### 5. Drive demo load

After deployment, retrieve the Producer function name from the stack output and invoke it directly (simplest — no SigV4 signing needed) or send SigV4-signed requests to its Function URL:

```bash
# Send a single demo message via direct Lambda invoke
aws lambda invoke --function-name <project>-dev-producer \
  --cli-binary-format raw-in-base64-out \
  --payload '{"requestContext":{"http":{"method":"POST"}},"body":"{\"hello\":\"world\"}"}' /tmp/out.json

# Or use `awscurl` (SigV4-signing curl wrapper) against the Function URL for a loop:
for i in $(seq 1 50); do
  awscurl --service lambda -X POST "<function-url>" -d "{\"n\":$i}"
done
```

### 6. Run a FIS experiment

Navigate to the AWS FIS console, select one of the three experiment templates (`D-1`, `D-2`, `D-3`), click **Start experiment**, and watch the SQS main queue's `ApproximateNumberOfMessagesVisible` metric (and, for D-2, the DLQ's message count) in CloudWatch while demo load continues arriving.

### Observed results (ap-northeast-1)

| Scenario | What happened |
| -------- | -------------- |
| **D-1** | The FIS extension logged `found active faults` ~90s after experiment start; every subsequent consumer invocation returned without the handler running (`modifying the function response`). `ApproximateNumberOfMessagesNotVisible` held at 1 for the full window — a message cycling through failed-receive → visibility-timeout → redeliver. Once the fault cleared (`no active faults found`, `persisting environment reset save file`), the backlog drained cleanly |
| **D-2** | Confirmed without waiting the full 20 minutes: messages still redelivering from a prior D-1 run crossed their 3rd failed receive within seconds of D-2 starting, and the DLQ populated immediately. `receive-message` on the DLQ showed `ApproximateReceiveCount: 4` — one past the `maxReceiveCount=3` threshold, exactly as the redrive policy specifies |
| **D-3** | Not re-run live in this verification pass — the underlying mechanism (`invocation-add-delay`) is identical to what Architecture B's B-2 scenario already validated end-to-end |

## Testing

```bash
cd infrastructure
npm ci

# Run all tests for this workspace
npm run test --workspace=fis-arch-d-sqs-lambda

# Snapshot tests only
npm run test:snapshot --workspace=fis-arch-d-sqs-lambda

# CDK Nag compliance checks
npm run test:compliance --workspace=fis-arch-d-sqs-lambda

# Update snapshots after intentional changes
npm run test:snapshot:update --workspace=fis-arch-d-sqs-lambda
```

### What the tests cover

| Test suite | File | Assertions |
| ---------- | ---- | ---------- |
| Snapshot | `test/snapshot/snapshot.test.ts` | Full CFn template snapshots for all 3 stacks; DynamoDB PAY_PER_REQUEST; exactly 2 SQS queues with a `maxReceiveCount=3` redrive policy and `VisibilityTimeout=60`; Lambdas on Python 3.13; SQS event source mapping with `BatchSize=5` and `ReportBatchItemFailures`; Function URL with `AWS_IAM` auth; exactly 3 FIS templates, all with stop conditions and all using a real `aws:lambda:function` action |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutions pack — no unsuppressed warnings or errors |

## Cost Estimation

All services are serverless (pay-per-use), so the cost at rest is effectively **zero**.

| Service | Billing Model | Estimated cost during experiments |
| ------- | -------------- | ---------------------------------- |
| DynamoDB | PAY_PER_REQUEST | ~$0 at idle; <$0.01 for a few hundred test writes |
| SQS | Per request | <$0.01 for a few thousand demo messages |
| Lambda | Per invocation + duration | <$0.01 for a 20-minute experiment at modest demo load |
| S3 FIS config bucket | near-empty, 1-day expiry | <$0.01 |
| CloudWatch | Metrics + logs | ~$0.01/month for experiment logs |
| **FIS** | **$0.10 per action-minute** | A 20-minute D-2 run alone is ~$2; a full 3-scenario cycle is a few dollars |
| **Total (one full test cycle)** | | **≈ $2–3, dominated by FIS action-minutes** |

**Correction vs. earlier versions of this doc:** FIS is **not free** — it bills $0.10 per action-minute, same as every other FIS-based workspace in this series.

## Security Considerations

- **Consumer execution role follows least privilege**: `dynamodb:PutItem` (and the sub-resource wildcards CDK's `grantWriteData()` generates for index resources) on the specific table, the SQS event source's standard grant scoped to the main queue, and `s3:ListBucket`/`s3:GetObject` scoped to the `FisConfigs/` prefix of the config bucket (for the extension).
- **Producer execution role follows least privilege**: only `sqs:SendMessage` on the main queue, via `queue.grantSendMessages()`.
- **Producer Function URL requires IAM auth**: `AuthType: AWS_IAM` means every request must be SigV4-signed with valid AWS credentials — there is no public, unauthenticated entry point into this pipeline.
- **Both queues enforce TLS**: `enforceSSL: true` denies any non-HTTPS request to either queue.
- **FIS config bucket**: all public access blocked, S3-managed encryption, TLS enforced, 1-day object expiry so stale fault configs do not linger.
- **FIS role follows least privilege**: `s3:PutObject`/`s3:DeleteObject` scoped to `<bucket>/FisConfigs/*`; `lambda:GetFunction` and `tag:GetResources` (target resolution); `cloudwatch:DescribeAlarms` on the stop-condition alarm. No DynamoDB or SQS access.
- **No VPC exposure**: there is no VPC, no public subnet, and no security group — the only entry point is the IAM-authenticated Function URL.
- **Stop condition is mandatory**: all FIS templates include the queue-backlog alarm stop condition, which limits maximum experiment blast radius (unbounded backlog growth).

## Troubleshooting

| Symptom | Likely cause | Resolution |
| ------- | ------------ | ---------- |
| `cdk deploy` fails with `No parameters found for environment` | Missing `dev-params.ts` export | Verify `parameters/index.ts` imports `./dev-params` and that it registers under the `dev` key |
| FIS template create fails: `Invalid actionId ... 404` | An action ID that does not exist in the Region | Check `aws fis list-actions` — Lambda-targeted actions are limited to the `aws:lambda:function` family |
| Producer Function URL returns 403 | Missing/invalid SigV4 signature | Use `aws lambda invoke`, an SDK, or a SigV4-signing tool (e.g. `awscurl`) — plain unauthenticated `curl` is rejected by design |
| Errors take ~1 minute to appear during D-1/D-2 | Expected — FIS Lambda extension slow-poll ramp-up | Wait ~60s; check CloudWatch Logs for `AWS FIS EXTENSION - found active faults` to confirm the fault is genuinely active |
| FIS experiment stops immediately | Stop condition alarm is already in `ALARM` state | Reset the alarm first (`aws cloudwatch set-alarm-state --alarm-name ... --state-value OK`) |
| DLQ stays empty during D-2 | Not enough messages were in flight during the 20-minute window | Drive continuous demo load into the queue before/during the experiment |
| `Table not found` Lambda error | BaseStack not yet deployed | Deploy stacks in order: Base → App → FIS |

## Clean-up

```bash
PROJECT=<project> ENV=dev npm run stage:destroy:all -w workspaces/fis-arch-d-sqs-lambda -- --force
```

All resources have `removalPolicy: DESTROY` (and `autoDeleteObjects` on the S3 config bucket), so the destroy command removes the DynamoDB table, both SQS queues, both Lambda functions, the Function URL, the FIS config bucket, the FIS templates, and the CloudWatch log groups completely.

## Summary

This workspace demonstrates FIS chaos engineering on an event-driven SQS+Lambda consumer architecture, working within a real constraint: FIS has no native action for SQS or DynamoDB, and — as deploy-verification uncovered — no action for setting Lambda reserved concurrency either. All three scenarios instead use the `aws:lambda:function` action family via the FIS Lambda extension, the same proven mechanism Architecture B uses:

- **D-1** verifies the pipeline recovers cleanly from a short consumer outage — messages redeliver and the backlog drains once the fault clears.
- **D-2** deliberately drives messages into the DLQ (outage duration ≫ the redrive threshold) to verify DLQ routing, alarming, and replay procedures actually work.
- **D-3** verifies behavior under sustained partial capacity loss — a more realistic "degraded, not dead" failure than a hard outage.

The serverless architecture keeps experiment costs low (a few dollars per full test cycle, dominated by FIS action-minutes) and eliminates VPC management overhead, making it easy to iterate quickly on resilience scenarios for event-driven consumers.

## References

- [AWS FIS — Supported actions](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [Use the AWS FIS `aws:lambda:function` actions](https://docs.aws.amazon.com/fis/latest/userguide/use-lambda-actions.html)
- [CDK aws-fis module (L1 constructs)](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_fis-readme.html)
- [Amazon SQS dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [Using Lambda with Amazon SQS (event source mapping, batch item failures)](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)
- [Lambda Function URLs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-urls.html)
