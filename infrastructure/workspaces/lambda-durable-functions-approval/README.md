# Approval Workflow on Lambda Durable Functions - AWS CDK Reference Architecture

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

A human-in-the-loop business flow (submit → notify approvers → **wait up to 48 hours** → fulfill / reject / expire) implemented as **one Lambda durable function**. While it waits, the function is suspended and no compute is billed. When the decision API calls `SendDurableExecutionCallbackSuccess`, the function resumes from its checkpoints (replay).

The workflow is plain sequential TypeScript, with no Step Functions state machine. In exchange, the durable-specific rules (determinism, qualified ARNs, version pinning, idempotency) must be followed in both code and infrastructure. This workspace shows how.

> **Status: not deploy-verified yet.** `cdk synth` (with esbuild bundling), unit tests and cdk-nag pass, but the stack has not been deployed to an account. It is listed with `draft: true` in `pages/patterns.json`.

## 📑 Table of Contents

- [Architecture Overview](#️-architecture-overview)
- [How durable functions work (the parts that matter here)](#-how-durable-functions-work-the-parts-that-matter-here)
- [Design Decisions and Best Practices](#-design-decisions-and-best-practices)
- [Comparison with Step Functions](#-comparison-with-step-functions)
- [Cost](#-cost)
- [Security Considerations](#-security-considerations)
- [Prerequisites](#-prerequisites)
- [Deployment](#-deployment)
- [Usage](#usage)
- [Testing Strategy](#-testing-strategy)
- [Operations](#-operations)
- [Cleanup](#-cleanup)
- [References](#-references)

## 🏗️ Architecture Overview

![Architecture Diagram](overview.drawio.svg)

```text
Client (SigV4 / IAM)
  │
  ▼
API Gateway (REST, AWS_IAM, JSON Schema validation, throttling)
  ├─ POST /requests                 → StartRequest ──Invoke(Event, DurableExecutionName)──▶ Workflow:live (durable)
  ├─ POST /requests/{id}/decision   → SubmitDecision ──SendDurableExecutionCallbackSuccess──▶ (waiting execution resumes)
  └─ GET  /requests/{id}            → GetRequest ──▶ DynamoDB (status projection)

Workflow (durable function, alias: live)
  register-request ─▶ wait-for-approval (callback, up to 48h, no compute) ─┬─ approved ─▶ fulfill-request ─▶ mark-completed
        │                    │ submitter: store callbackId / notify via SNS ├─ rejected ─▶ mark-rejected
        ▼                    ▼                                              └─ timeout  ─▶ mark-expired
     DynamoDB             SNS (approval requests, KMS)

Ops: EventBridge "Durable Execution Status Change" (FAILED / TIMED_OUT / STOPPED) ─▶ SNS (alerts)
     DLQ (SQS) ─▶ CloudWatch alarm ─▶ SNS (alerts)
```

### Components

| Component | Role |
|---|---|
| `WorkflowFunction` (durable) | The approval flow. `DurableConfig`: 7-day execution timeout, 14-day history retention. 60 s per invocation |
| `live` alias | Every new execution starts on this alias (a published version) |
| `StartRequest` | Accepts a request and starts an execution **asynchronously** with a `DurableExecutionName` |
| `SubmitDecision` | Accepts approve / reject and completes the callback |
| `GetRequest` | Returns status from DynamoDB; never calls `GetDurableExecution` |
| DynamoDB `requests` | Status projection and the only place the `callbackId` is stored |
| SNS (approvals / alerts) | Encrypted with a customer managed KMS key |
| SQS DLQ | Original events of failed executions |
| EventBridge rule | Alerts on abnormal endings of this function only |

## 🔁 How durable functions work (the parts that matter here)

- **Checkpoint and replay**: the result of each `context.step()` is checkpointed. On resume the handler **runs again from the top**, and completed steps return their stored result instead of running again.
- **Waiting**: `waitForCallback()` creates a callback ID, runs the submitter and suspends. It resumes when `SendDurableExecutionCallbackSuccess` arrives or the timeout fires.
- **Time limits**: each invocation is still capped at 15 minutes, and the whole execution can run up to `executionTimeout` (max 366 days). **Synchronous invokes and event source mappings cap the entire execution at 15 minutes**, which is why this stack starts executions asynchronously.
- **Version pinning**: an execution stays on the version it started on. Moving the alias affects only new executions.

## 🎯 Design Decisions and Best Practices

### 1. Asynchronous invoke + `DurableExecutionName` for idempotent starts

`StartRequest` invokes with `InvocationType: 'Event'` and `DurableExecutionName: approval-<requestId>`. A retry with the same name and payload returns the existing execution. A different payload gets `DurableExecutionAlreadyStartedException` (→ HTTP 409).

- Clients may set the request ID with an `Idempotency-Key` header: 1-55 characters of `[A-Za-z0-9_-]`, which is the 64-character execution-name limit minus the `approval-` prefix.
- **No timestamps in the payload.** The idempotency check compares payloads, so a retry must produce identical bytes.

> The TypeScript sample of the intermediary-function pattern in the AWS docs only puts `executionName` in the payload and never sets the `DurableExecutionName` parameter, so copying it as is does not give idempotent starts.

### 2. Production executions go through the `live` alias, and old versions are retained

- Executions started on `$LATEST` **replay on new code** if you deploy while they wait. Added or renamed steps then no longer match the checkpoints.
- `currentVersionOptions.removalPolicy: RETAIN` keeps old `AWS::Lambda::Version` resources on deploy. Deleting a version breaks the executions waiting on it.
- The trade-off is that versions accumulate, so delete versions with no running executions as an operational task (see [Operations](#-operations)).

### 3. Everything non-deterministic runs inside steps

Clock, randomness and I/O run only inside a `step` or the callback submitter. `parseDecision()` is a pure function of the checkpointed callback result, so it can sit outside a step. **Step names are part of the checkpoint contract**: never rename a step in a version that still has running executions.

### 4. Steps are written for at-least-once execution

The default step semantics are at-least-once per retry: an interruption can make a step run again. Every DynamoDB write is therefore conditional or idempotent:

| Operation | Technique |
|---|---|
| Register | `attribute_not_exists(requestId)` |
| Wait for approval | `status IN (SUBMITTED, WAITING_APPROVAL)` |
| Fulfill | deterministic ID + `if_not_exists` |
| Claim decision | `status = WAITING_APPROVAL AND callbackId = :cb` (only one caller wins) |

For non-idempotent side effects such as charging a card, use `StepSemantics.AtMostOncePerRetry` with no retries, and create the idempotency key **in its own step** (see the code comment).

### 5. Status reads do not use `GetDurableExecution`

`GetDurableExecution` allows **30 requests per second** per Region. User-facing status polling would hit that quickly, so steps project the status into DynamoDB and the API reads from there.

### 6. The callback ID never leaves the backend

Approvers decide by request ID. The callback ID is stored only in DynamoDB, stripped from GET responses and left out of the SNS message. Requesters cannot approve their own requests (HTTP 403, separation of duties).

### 7. Failure detection uses both EventBridge and the DLQ

Lambda does not retry a failed durable execution that was started asynchronously.

- EventBridge `Durable Execution Status Change` alerts immediately on `FAILED` / `TIMED_OUT` / `STOPPED`. The `functionArn` prefix is `<function-arn>:`; the trailing colon keeps it from matching a different function such as `<name>-v2`.
- The DLQ keeps the **original event**, which the EventBridge event does not contain, so use it for reprocessing.
- Durable functions do not support Lambda destinations, so a DLQ is used.

### 8. `@aws-sdk/client-lambda` is bundled

`StartRequest` and `SubmitDecision` use `bundleAwsSDK: true`. It is unverified whether the runtime-provided SDK supports `DurableExecutionName` and the callback APIs. The durable execution SDK is also bundled and pinned to a major version (`^2.7.1`), as the AWS docs recommend.

## 🔀 Comparison with Step Functions

| Aspect | This stack (durable functions) | Step Functions (e.g. [`fis-arch-f-stepfunctions-saga`](../fis-arch-f-stepfunctions-saga/)) |
|---|---|---|
| Flow definition | Sequential TypeScript | ASL / CDK state machine |
| Waiting for approval | `waitForCallback` (no compute while waiting) | `.waitForTaskToken` |
| AWS service integration | SDK calls wrapped in steps | 220+ native integrations |
| Visualization | Execution history API / console | Execution graph |
| Main pitfalls | Determinism, version pinning, step-name compatibility | Per-transition pricing, ASL expressiveness |

Durable functions fit when workflow and business logic live together in Lambda. Step Functions fits flows that orchestrate many AWS services or that non-engineers need to review. This is a summary of the AWS documentation's comparison.

## 💰 Cost

Durable functions add charges for **durable operations, data written and data retained** on top of regular Lambda pricing. Rates below are read from the example on the AWS pricing page (us-east-1), checked 2026-10-21.

| Item | us-east-1 | ap-northeast-1 |
|---|---|---|
| Durable operations | $8.00 per million | not verified |
| Data written | $0.25 per GB | not verified |
| Data retained | $0.15 per GB-month | not verified |

**Rough estimate** (10,000 requests per month):

- Operations per execution are the start plus each step. `waitForCallback` uses a child context, a callback and a submitter step internally, so it may count as several operations (not verified). Assuming 7 operations per execution: 70,000 × $8 / 1M ≈ **$0.56**.
- Every checkpoint is under 1 KB, so written and retained data are negligible.
- Compute is 2-3 short invocations per execution (including replays). The 48-hour wait is not billed.
- After deploying, measure the real values with the `DurableExecutionOperations` and `DurableExecutionStorageWrittenBytes` metrics.

The KMS key (monthly key fee), API Gateway, DynamoDB on-demand and SNS add their usual charges.

## 🔒 Security Considerations

### Implemented

- All API methods use `AWS_IAM` authorization, JSON Schema validation, stage throttling and access logging.
- Only `lambda:SendDurableExecutionCallbackSuccess` is granted, on `<function-arn>:*`. Callbacks are authorized against the durable execution ARN (`<function-arn>:<version>/durable-execution/...`), which an unqualified function ARN never matches.
- API handlers get no `StopDurableExecution` / `GetDurableExecutionHistory`.
- SNS uses a rotating customer managed KMS key and SQS uses SSE-SQS; both enforce TLS.
- The callback ID is never returned by the API or included in notifications. Requesters cannot approve their own requests.

### Intentionally out of scope (add per environment)

- WAF (regional web ACL). Add it before exposing the API publicly.
- End-user authentication such as Cognito. The stack targets IAM principals (internal tools and services).
- Custom checkpoint encryption (custom serdes) and CMK encryption of durable execution data.

### CDK Nag

`test/compliance/cdk-nag.test.ts` runs AwsSolutions. Every suppression is narrowed with `appliesTo` and carries a reason: three AWS managed policies, the `:*` callback resource, KMS `GenerateDataKey*`, COG4 and APIG3.

## 📋 Prerequisites

- An AWS account in a Region where durable functions are available, bootstrapped for CDK. The default is `ap-northeast-1`; check availability before deploying.
- AWS CLI v2 with a `${PROJECT}-${ENV}` profile
- Node.js 22+, `aws-cdk-lib` 2.273.0+ (`durableConfig`)
- No Docker needed (local esbuild bundling)
- curl 7.75+ (`--aws-sigv4`) and `jq` for calling the API

## 🚀 Deployment

```bash
cd infrastructure
npm install

export PROJECT=myproject
export ENV=dev

npm run bootstrap -w workspaces/lambda-durable-functions-approval   # first time only
npm run diff -w workspaces/lambda-durable-functions-approval
npm run stage:deploy:all -w workspaces/lambda-durable-functions-approval
```

To receive approval requests or alerts by e-mail, set `approverEmails` / `alertEmails` in `parameters/dev-params.ts` and confirm the subscription e-mails.

Outputs: `ApiUrl`, `WorkflowFunctionName`, `WorkflowAliasArn`, `RequestsTableName`, `WorkflowDlqUrl`.

## Usage

```bash
API="<ApiUrl output>"   # e.g. https://xxxx.execute-api.ap-northeast-1.amazonaws.com/dev/
eval "$(aws configure export-credentials --profile ${PROJECT}-${ENV} --format env)"
SIGV4=(--aws-sigv4 "aws:amz:ap-northeast-1:execute-api" --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" -H "x-amz-security-token: ${AWS_SESSION_TOKEN}")

# 1. Submit (a retry with the same Idempotency-Key and body attaches to the same execution)
curl -s "${SIGV4[@]}" -X POST "${API}requests" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: req-0001' \
  -d '{"title":"New laptop","amount":1200}' | jq

# 2. Status (WAITING_APPROVAL after a few seconds)
curl -s "${SIGV4[@]}" "${API}requests/req-0001" | jq

# 3. Approve (use a different IAM principal from the requester; the same one gets 403)
curl -s "${SIGV4[@]}" -X POST "${API}requests/req-0001/decision" \
  -H 'Content-Type: application/json' -d '{"approved":true,"comment":"OK"}' | jq

# 4. Execution internals (for operators; 15-30 rps API limits, do not call from the app)
aws lambda list-durable-executions-by-function --function-name "<WorkflowFunctionName>" --statuses RUNNING --profile ${PROJECT}-${ENV}
```

## 🧪 Testing Strategy

| Kind | File | What it covers |
|---|---|---|
| Workflow | `test/unit/approval-workflow.test.ts` | Runs the real orchestration code locally with `LocalDurableTestRunner` from `@aws/durable-execution-sdk-js-testing`: approve, reject, callback failure sent by an external system, step retry, no re-execution of completed steps on replay, malformed decision |
| Stack | `test/unit/lambda-durable-functions-approval-stack.test.ts` | `DurableConfig`, retained versions, alias, IAM scope, EventBridge pattern, and more |
| Snapshot | `test/snapshot/` | Full template and resource counts |
| Compliance | `test/compliance/cdk-nag.test.ts` | AwsSolutions |

**Limitation**: the `LocalDurableTestRunner` in testing SDK 1.3.x never fires callback timeouts, so the EXPIRED branch is tested with a stub context that returns `CallbackTimeoutError`. The SDK source confirms that `waitForCallback` rethrows `CallbackTimeoutError` unchanged, but this is still an open item for the deploy verification.

```bash
cd infrastructure/workspaces/lambda-durable-functions-approval
npx jest
```

## 🛠️ Operations

- **Deploy**: moving the alias to a new version affects only new executions. Running ones finish on their own version.
- **Cleaning up old versions**: delete a version only after `ListDurableExecutionsByFunction` shows no RUNNING executions on it. Retained versions consume the code storage quota.
- **Reprocessing**: inspect the original event in the DLQ, fix the cause, then resubmit. A `DurableExecutionName` cannot start a new execution while the old one is retained, so use a new request ID.
- **Deleting the function**: CloudFormation waits up to 1 hour for running durable executions before timing out (per the `aws-cdk-lib` README). Stop executions first.

## 🧹 Cleanup

```bash
# Waiting executions block function deletion; stop them first
aws lambda list-durable-executions-by-function --function-name "<WorkflowFunctionName>" --statuses RUNNING --profile ${PROJECT}-${ENV}
aws lambda stop-durable-execution --durable-execution-arn "<arn>" --profile ${PROJECT}-${ENV}

npm run stage:destroy:all -w workspaces/lambda-durable-functions-approval
```

Not verified: whether `AWS::Lambda::Version` resources with `removalPolicy: RETAIN` disappear together with the function on stack deletion. This will be checked during deploy verification. If anything remains, delete the function with `aws lambda delete-function`.

## 📚 References

### AWS documentation (checked 2026-10-21)

- [Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html)
- [Invoking Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-invoking.html) / [Event source mappings with durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-invoking-esm.html)
- [Idempotency](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-idempotency.html) / [Security and permissions](https://docs.aws.amazon.com/lambda/latest/dg/durable-security.html)
- [Best practices](https://docs.aws.amazon.com/lambda/latest/dg/durable-best-practices.html) / [Monitoring](https://docs.aws.amazon.com/lambda/latest/dg/durable-monitoring.html)
- [Durable functions or Step Functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-step-functions.html)
- [Lambda quotas — Durable functions](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html#durable-functions-quotas)
- [AWS Durable Execution SDK Developer Guide](https://docs.aws.amazon.com/durable-execution/)
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/)

### Related architectures

- [fis-arch-f-stepfunctions-saga](../fis-arch-f-stepfunctions-saga/) — multi-step flow with compensation on Step Functions
- [apigw-single-purpose-lambda](../apigw-single-purpose-lambda/) — the basic API Gateway + one-Lambda-per-route shape
- [eventbridge-custom-bus](../eventbridge-custom-bus/) — EventBridge routing

## 📄 License

See [LICENSE](../../LICENSE).

## 🏆 About This Reference Architecture

**Target level**: 300 (Intermediate)
