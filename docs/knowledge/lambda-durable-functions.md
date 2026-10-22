# Lambda Durable Functions — Verified Behaviors

Verified while deploy-verifying [`lambda-durable-functions-approval`](../../infrastructure/workspaces/lambda-durable-functions-approval/)
(ap-northeast-1, `aws-cdk-lib` 2.273.0, `@aws/durable-execution-sdk-js` 2.x, October 2026).
Everything below was observed on a real deployment, not inferred from the docs.

## An asynchronous start with a reused name and a different payload is not rejected — it lands in the DLQ

The docs say a start with the same `DurableExecutionName` **and the same payload** returns the
existing execution. They do not say what an `InvocationType: 'Event'` start with a *different*
payload does. Observed:

- `Invoke` returns **202 with the existing execution's `DurableExecutionArn`**, both while that
  execution is running and after it has `SUCCEEDED`. `DurableExecutionAlreadyStartedException` is
  **not** raised, so a `catch` for it (to map to HTTP 409) is dead code for async invokes.
- The event then fails asynchronously and is sent to the function's DLQ with message attributes
  `ErrorCode = 400` and
  `ErrorMessage = DurableExecutionAlreadyExists. An execution with this name already exists with different payload.`
  A DLQ-depth alarm fires as if a workflow had failed.
- A retry with the **same** payload produces no DLQ message.

How it was confirmed: two `POST`s with the same `Idempotency-Key` and different bodies, then
`aws sqs receive-message --attribute-names All --message-attribute-names All` on the DLQ.

Fix used: check your own record of the request (here, the DynamoDB status projection) before
invoking and reject a mismatch yourself. Only a retry that arrives before the first step has
written the record (about one second) still reaches the DLQ. When triaging the DLQ, treat
`ErrorCode 400` + `DurableExecutionAlreadyExists` as a duplicate start, not a workflow failure.

## `waitForCallback` timeout fires on time (and the local runner cannot test it)

`LocalDurableTestRunner` in `@aws/durable-execution-sdk-js-testing` 1.3.x never fires callback
timeouts, so the timeout branch can only be checked on AWS. With
`waitForCallback(..., { timeout: { minutes: 2 } })`, `CallbackTimeoutError` was thrown and the
`mark-expired` step ran exactly 2 minutes after the callback started (16:23:35 → 16:25:36).
Make the timeout a parameter with a small unit (minutes) so a verification run can use 2 minutes.

## `StopDurableExecution` on a waiting execution

- Status becomes `STOPPED`; an EventBridge rule on `Durable Execution Status Change` with
  `status: [STOPPED]` matched once (`AWS/Events MatchedEvents = 1`).
- The original invoke event is sent to the DLQ with `ErrorCode = 200`.
- **No step runs**, so anything the workflow projects (a DynamoDB status item) keeps its last value,
  for example `WAITING_APPROVAL`. Clean it up yourself, or drive the projection from the
  EventBridge event.

## What a suspended execution looks like

`aws lambda get-durable-execution-history` for an execution waiting on a callback:

```text
ExecutionStarted   approval-<id>
StepStarted        register-request
StepSucceeded      register-request
ContextStarted     wait-for-approval
CallbackStarted
StepStarted        (submitter)
StepSucceeded      (submitter)
InvocationCompleted
```

`InvocationCompleted` with status `RUNNING` is the suspended state: nothing runs until the callback
or its timeout.

## Retained versions do not outlive the function

The stack keeps old `AWS::Lambda::Version` resources (`currentVersionOptions.removalPolicy: RETAIN`)
so that waiting executions can resume on them. On `cdk destroy`, the function was deleted together
with its three published versions: `list-versions-by-function` returned `ResourceNotFoundException`
afterwards. Retaining versions therefore protects in-flight executions across deploys, not across a
stack deletion. Stop running executions first (`StopDurableExecution`); CloudFormation otherwise
waits for them when deleting the function.
