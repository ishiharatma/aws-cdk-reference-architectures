# FIS Chaos Engineering — Architecture B: CloudFront + API Gateway HTTP API + Lambda + DynamoDB

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20CloudFront%20%7C%20API%20Gateway%20%7C%20Lambda%20%7C%20DynamoDB-orange?style=flat-square)

## Introduction

This project is a reference implementation for AWS Fault Injection Service (FIS) chaos engineering on a **serverless web API** architecture. A single CloudFront distribution routes all traffic through an API Gateway HTTP API to a Python Lambda function, which reads and writes a DynamoDB table.

Four FIS experiment templates inject faults **into Lambda invocations** using the `aws:lambda:function` actions. These actions require the AWS FIS Lambda extension (attached as a layer) — the function code itself is never modified.

| Scenario | Fault Injected | Duration | What It Validates |
| -------- | -------------- | -------- | ----------------- |
| **B-1** Invocation Error — hard outage | `aws:lambda:invocation-error`, `preventExecution=true`, 100% | 5 min | Every request fails with 500 **without the handler running**. API 500 propagation, CloudFront error handling, client retry behaviour during a total outage |
| **B-2** Invocation Latency | `aws:lambda:invocation-add-delay`, `+10 s`, 100% | 5 min | A fixed 10 s delay is added to the start of every invocation (still under the 29 s function / 30 s API GW timeout). Timeout budgets, client deadlines, latency alarms |
| **B-3** Partial Invocation Error | `aws:lambda:invocation-error`, `preventExecution=false`, 50% | 5 min | Half of invocations fail **after** executing the handler, so side effects may already have happened. Idempotency, partial-failure handling, retry amplification |
| **B-4** Overridden HTTP Integration Response | `aws:lambda:invocation-http-integration-response`, `statusCode=500` | 5 min | API Gateway receives a synthetic 500 `application/json` response without the handler running. API GW → CloudFront error-page behaviour for a well-formed-but-failing upstream |

All experiments share a CloudWatch Alarm stop condition that automatically halts the experiment if the Lambda error count exceeds **100 per minute** — set well above the load these experiments generate, so it catches a runaway blast radius rather than the injected faults themselves.

> ### ⚠️ Why not inject DynamoDB faults directly?
> An earlier version of this workspace tried `aws:fis:inject-api-internal-error` / `aws:fis:inject-api-throttle-error` with `service: dynamodb`, and a fictional `aws:lambda:put-function-concurrent-executions` action. **Both fail at deploy time.** The `aws:fis:inject-api-*` actions do not support `dynamodb` as a service value (the API rejects it with *"The service parameter value is not supported for the action"*), and no FIS action sets Lambda reserved concurrency. The only supported way to inject faults into this serverless path today is the `aws:lambda:function` action family, which is what B-1–B-4 now use. See [Implementation Highlights](#6-lessons-learned).

## Architecture Overview

![Architecture Overview](docs/architecture.html)

```
Viewer (HTTPS)
    │
    ▼
CloudFront Distribution  (price class 100, TLS 1.2+, HTTP/2+3, IPv6)
    │  cache-disabled pass-through
    ▼
API Gateway HTTP API  (default stage, access logging to CW Logs)
    │  Lambda proxy integration
    ▼
Lambda Function  (Python 3.13, 256 MB, 29 s timeout)
    │  + AWS FIS Lambda extension layer (fault injection)
    │  GET / POST / DELETE  /items
    ▼
DynamoDB Table  (PAY_PER_REQUEST, string partition key: id)

FIS ⇄ extension config exchange:
    S3 bucket  <project>-<env>-b-fis-config-<account>  (prefix FisConfigs/)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIS Experiment Templates (FisStack)   target: aws:lambda:function (API handler ARN)

B-1  aws:lambda:invocation-error                  preventExecution=true,  100%, PT5M
B-2  aws:lambda:invocation-add-delay              startupDelayMilliseconds=10000, 100%, PT5M
B-3  aws:lambda:invocation-error                  preventExecution=false, 50%,  PT5M
B-4  aws:lambda:invocation-http-integration-response  statusCode=500, contentTypeHeader=application/json, PT5M
```

### Key Design Benefits

| Feature | Benefit |
| ------- | ------- |
| No VPC required | Fully serverless — no NAT Gateway, no subnet planning, no VPC hourly charges |
| `aws:lambda:function` actions | FIS injects faults into function invocations through the FIS Lambda extension; the handler code is untouched |
| `preventExecution` toggle (B-1 vs B-3) | The same action models both a fail-fast outage (handler never runs) and a fail-after-work error (side effects already committed) |
| HTTP integration response override (B-4) | Simulates a well-formed 500 from the integration — distinct from a Lambda crash — to exercise API GW/CloudFront error mapping |
| Shared stop condition | One CloudWatch Alarm halts any of the four experiments automatically |
| CloudFront as stable front door | Stable domain, WAF attachment point, and a natural place to observe 4xx/5xx rates during experiments |

## Prerequisites

- AWS CLI v2 installed and configured
- Node.js 20 or later
- AWS CDK CLI (`npm install -g aws-cdk`)
- Basic knowledge of TypeScript and Python
- AWS account with the FIS service-linked role (auto-created on first FIS use)

> **No VPC or NAT Gateway costs**: this architecture uses only serverless services. The dominant ongoing cost at rest is zero (DynamoDB PAY_PER_REQUEST, Lambda invocations, S3 config bucket near-empty). See [Cost Estimation](#cost-estimation).

## Project Directory Structure

```text
fis-arch-b-apigw-lambda/
├── bin/
│   └── fis-arch-b-apigw-lambda.ts        # App entry point (Stage instantiation)
├── lambda/
│   └── api-handler/
│       └── index.py                       # Python 3.13 CRUD handler for DynamoDB
├── lib/
│   ├── stages/
│   │   └── fis-chaos-stage.ts             # Stage: BaseStack → AppStack → FisStack
│   └── stacks/
│       ├── base-stack.ts                  # DynamoDB table
│       ├── app-stack.ts                   # Lambda (+ FIS extension layer) + API GW HTTP API + CloudFront + FIS config bucket
│       └── fis-stack.ts                   # 4 FIS experiment templates + IAM + alarm
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
├── cdk.json
├── package.json
└── tsconfig.json
```

## Data Flow

```text
Viewer (browser or curl)
  │  HTTPS
  ▼
CloudFront Distribution   (CACHING_DISABLED, ALL_VIEWER_EXCEPT_HOST_HEADER)
  ▼
API Gateway HTTP API  ($default route → Lambda proxy integration)
  ▼
Lambda Function (Python 3.13)   ── AWS FIS Lambda extension intercepts the invocation ──►
  ├── GET  /items          → table.scan()
  ├── POST /items          → table.put_item()   (body: {"name": "..."} )
  ├── GET  /items/{id}     → table.get_item()
  └── DELETE /items/{id}   → table.delete_item()
  ▼
DynamoDB Table  (partition key: id, UUID generated by the handler on POST)
```

### FIS Injection Point

The `aws:lambda:function` actions inject faults through the **AWS FIS Lambda extension**, attached to the function as a layer. When an experiment starts, FIS writes the active fault configuration to an S3 prefix; the extension polls that prefix and applies the fault (return an error, add a delay, or override the integration response) around the handler invocation. Nothing in `index.py` changes.

Because the extension only *polls*, faults are not instantaneous:

- **Ramp-up**: up to ~60 s from experiment start until every invocation is affected (the extension's slow-poll interval). B-1 and B-4 in practice reach full effect within 15–60 s; B-3 (50%) took ~2.5 min to converge in our runs.
- **Ramp-down**: up to ~20 s after the action ends before invocations are clean again.

## Key Components and Design Points

| Component | Design Points |
| --------- | ------------- |
| DynamoDB Table | PAY_PER_REQUEST billing; costs zero at rest; PITR disabled for minimal cost during experiments |
| Lambda Function | Python 3.13, 256 MB, 29 s timeout (1 s under API GW's 30 s limit). Carries the FIS extension layer + `AWS_LAMBDA_EXEC_WRAPPER=/opt/aws-fis/bootstrap`, `AWS_FIS_CONFIGURATION_LOCATION=arn:aws:s3:::<bucket>/FisConfigs/`, `AWS_FIS_POLL_MAX_WAIT_MILLISECONDS=2000` |
| FIS extension layer | Resolved per-Region from the public SSM parameter `/aws/service/fis/lambda-extension/AWS-FIS-extension-x86_64/1.x.x` (x86_64 matches the default Lambda architecture) |
| FIS config bucket | `<project>-<env>-b-fis-config-<account>` — S3-managed encryption, all public access blocked, 1-day lifecycle expiry, one per Region. FIS writes fault config here; the extension reads it |
| API Gateway HTTP API | Default stage, `$default` catch-all route, access logging to CloudWatch Logs, no authorizer (public demo) |
| CloudFront Distribution | `CACHING_DISABLED` cache policy, `ALL_VIEWER_EXCEPT_HOST_HEADER` origin request policy |
| FIS IAM Role | `s3:PutObject`/`s3:DeleteObject` on `<bucket>/FisConfigs/*`; `lambda:GetFunction` and `tag:GetResources` on `*`; `cloudwatch:DescribeAlarms` on the stop-condition alarm; CloudWatch Logs delivery permissions |
| CloudWatch Stop Alarm | `LambdaErrors >= 100` over 1 minute — shared by all 4 templates |
| FIS Log Group | `/fis/<project>-<env>-b` — ONE_MONTH retention, auto-deleted on stack destroy |

## Implementation Highlights

### 1. Lambda CRUD handler for DynamoDB

The Lambda function is intentionally simple — it exists as a target for FIS fault injection, not as a production-grade service. It propagates DynamoDB exceptions to API Gateway as HTTP 500, so faults are immediately visible in the HTTP response-code distribution and in CloudWatch metrics.

### 2. The FIS Lambda extension is a hard prerequisite

`aws:lambda:function` actions **do not work on a bare function**. The one-time setup (all in `app-stack.ts`) is:

```typescript
// Resolve the extension layer ARN for this Region from a public SSM parameter
const fisExtensionLayerArn = ssm.StringParameter.valueForStringParameter(
    this, '/aws/service/fis/lambda-extension/AWS-FIS-extension-x86_64/1.x.x',
);

new lambda.Function(this, 'ApiFunction', {
    // ...
    layers: [lambda.LayerVersion.fromLayerVersionArn(this, 'FisExtensionLayer', fisExtensionLayerArn)],
    environment: {
        TABLE_NAME: props.table.tableName,
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/aws-fis/bootstrap',
        AWS_FIS_CONFIGURATION_LOCATION: `arn:aws:s3:::${this.fisConfigBucket.bucketName}/FisConfigs/`,
        AWS_FIS_POLL_MAX_WAIT_MILLISECONDS: '2000', // recommended when preventExecution=true
    },
});

// The extension (running in the function's execution role) reads fault config from S3
this.apiFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject'],
    resources: [`${this.fisConfigBucket.bucketArn}/FisConfigs/*`],
}));
```

The S3 bucket is the communication channel between FIS and the extension: FIS's role has `s3:PutObject`/`s3:DeleteObject` on the prefix; the function's role has `s3:GetObject`/`s3:ListBucket`.

### 3. B-1 vs B-3 — `preventExecution` models two very different failures

```typescript
// B-1: fail fast — handler never runs, no side effects, 100% of requests
parameters: { duration: 'PT5M', invocationPercentage: '100', preventExecution: 'true' }

// B-3: fail after work — handler runs (writes may commit), then 50% return an error
parameters: { duration: 'PT5M', invocationPercentage: '50',  preventExecution: 'false' }
```

B-1 answers *"does the front end degrade cleanly when the API is entirely down?"*. B-3 answers the harder question *"when a write succeeds in DynamoDB but the caller sees a 500 and retries, do we double-write?"* — i.e. it is an idempotency test.

### 4. B-2 latency and B-4 integration-response override

```typescript
// B-2: a fixed 10 s pre-invocation delay — deliberately < the 29 s / 30 s timeouts
{ actionId: 'aws:lambda:invocation-add-delay',
  parameters: { duration: 'PT5M', invocationPercentage: '100', startupDelayMilliseconds: '10000' } }

// B-4: API Gateway gets a synthetic 500 without the handler running
{ actionId: 'aws:lambda:invocation-http-integration-response',
  parameters: { duration: 'PT5M', invocationPercentage: '100', preventExecution: 'true',
                statusCode: '500', contentTypeHeader: 'application/json' } }
```

B-4 differs from B-1 in *shape*: B-1 is a Lambda error (API Gateway synthesises the 502/500), B-4 is a well-formed 500 response body from the integration. Error dashboards and alarms that key off `Lambda Errors` vs `5xx` will see these differently.

### 5. Shared stop condition and automatic recovery

All four templates reference one CloudWatch Alarm (`LambdaErrors >= 100` in 1 minute). If the blast radius runs away, FIS stops the experiment and the extension reverts within the ramp-down window. The alarm also notifies an SNS topic (optional email via the `alarmEmail` parameter).

### 6. Lessons learned

- **`aws fis list-actions` is the source of truth.** The original design used `aws:lambda:put-function-concurrent-executions`, which does not exist — CloudFormation fails with `Invalid actionId ... Status Code: 404`. Always confirm an action ID against `aws fis list-actions` in the target Region before writing the template.
- **`aws:fis:inject-api-*` has a short service allow-list.** `service: dynamodb` is rejected outright. As of this writing these actions are practical only for a small set of services (e.g. EC2); they are **not** a general "make any AWS API fail" tool.
- **The extension polls — plan for ramp-up.** Health checks and dashboards need ~60 s of tolerance after `start-experiment` before the fault is fully in effect, and B-3-style partial percentages take longer still to converge.
- **`AWS_FIS_POLL_MAX_WAIT_MILLISECONDS` matters for `preventExecution=true`.** Without it, the very first invocations in the ramp-up window can slip through before the extension has the config. 2000 ms is the documented recommendation.
- **One S3 config bucket per Region.** The bucket must exist in the Region you start the experiment from; it can be shared across experiments and accounts.
- **Response streaming is incompatible** with the FIS Lambda extension — the extension suppresses streaming even when no fault is active. Not an issue here (buffered JSON responses).

## Deployment Guide

### 1. Install dependencies

```bash
cd infrastructure
npm ci
```

### 2. Configure environment parameters

Edit `parameters/dev-params.ts` to set your region and optionally an alarm email:

```typescript
const devParams: EnvParams = {
    region: 'ap-northeast-1',
    // alarmEmail: 'ops@example.com',
};
```

### 3. Bootstrap CDK (first time only)

```bash
PROJECT=<project> ENV=dev npm run bootstrap -w workspaces/fis-arch-b-apigw-lambda
```

### 4. Deploy all stacks

```bash
PROJECT=<project> ENV=dev npm run stage:deploy:all -w workspaces/fis-arch-b-apigw-lambda -- --require-approval never
```

Deploys the three stacks in dependency order:
1. `<project>-dev-b-base` — DynamoDB table
2. `<project>-dev-b-app` — Lambda + FIS extension layer + API GW + CloudFront + FIS config bucket
3. `<project>-dev-b-fis` — FIS templates + IAM + alarm

### 5. Smoke-test the API

```bash
CF=$(aws cloudformation describe-stacks --stack-name <project>-dev-b-app \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue" --output text)

curl -s https://$CF/items                                   # → {"items": []}
curl -s -XPOST https://$CF/items -d '{"name":"hello"}'      # → 201 {"id": "...", "name": "hello"}
curl -s https://$CF/items                                   # → the item is listed
```

### 6. Run a FIS experiment

**Console**: FIS → Experiment templates → pick `B-1`…`B-4` (the `Scenario` tag) → **Start experiment**.

**CLI**:

```bash
# Find the template IDs (they are tagged Scenario=B-1 .. B-4)
aws fis list-experiment-templates \
  --query "experimentTemplates[].{id:id, scenario:tags.Scenario, desc:description}" --output table

# Start one and capture the experiment id
EXP=$(aws fis start-experiment --experiment-template-id <EXT...> \
      --query "experiment.id" --output text)

# Watch it
watch -n5 "aws fis get-experiment --id $EXP --query 'experiment.state'"

# In another shell, watch the effect
while true; do curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' https://$CF/items; sleep 2; done
```

### Observed results (ap-northeast-1, 5-minute runs)

| Scenario | During the experiment | Recovery |
| -------- | --------------------- | -------- |
| **B-1** | API and CloudFront return **HTTP 500** for the full window; handler does not run (no DynamoDB writes) | 200 within seconds of the experiment completing |
| **B-2** | After a ~60 s ramp-up, response time goes from ~0.09 s to **~11.2 s**; status stays 200 | Latency back to baseline within ~60 s |
| **B-3** | After a ~2.5 min ramp-up, ~**50% of requests return 500**; the rest run normally (writes commit) | Clean within ~20 s |
| **B-4** | After a ~60 s ramp-up, API/CloudFront return **500 with an empty body**; handler does not run | 200 within seconds |

The stop-condition alarm (`LambdaErrors >= 100/min`) did **not** fire in any run — the demo's request rate is far below 100/min. Raise the request rate or lower the threshold to exercise the automatic-halt path.

## Testing

```bash
cd infrastructure
npm ci

npm run test         -w workspaces/fis-arch-b-apigw-lambda
npm run test:snapshot -w workspaces/fis-arch-b-apigw-lambda
npm run test:compliance -w workspaces/fis-arch-b-apigw-lambda

# After intentional changes:
npm run test:snapshot:update -w workspaces/fis-arch-b-apigw-lambda
```

| Test suite | File | Assertions |
| ---------- | ---- | ---------- |
| Snapshot | `test/snapshot/snapshot.test.ts` | Full CFn template snapshots for all 3 stacks; DynamoDB PAY_PER_REQUEST; Lambda Python 3.13 with the FIS extension layer; CloudFront + API GW counts; exactly 4 FIS templates; every template has a stop condition |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutions pack — no unsuppressed findings |

## Cost Estimation

Pricing is **on-demand list price, September 2026**, and excludes the AWS Free Tier (which covers most of the non-FIS usage below). Two regions are shown: **US East (N. Virginia) `us-east-1`** and **Asia Pacific (Tokyo) `ap-northeast-1`**.

### Idle / steady-state (per month, no traffic)

Everything here is pay-per-use and scales to (almost) zero when the API is not being called.

| Service | Basis | us-east-1 | ap-northeast-1 |
| ------- | ----- | --------- | -------------- |
| DynamoDB (PAY_PER_REQUEST) | no RCU/WCU reservation; storage of a handful of tiny items | ~$0.00 | ~$0.00 |
| Lambda | no invocations | $0.00 | $0.00 |
| API Gateway HTTP API | no requests | $0.00 | $0.00 |
| CloudFront | no requests / transfer | $0.00 | $0.00 |
| S3 FIS config bucket | near-empty, 1-day expiry | <$0.01 | <$0.01 |
| CloudWatch | 1 alarm ($0.10) + minimal log storage | ~$0.10 | ~$0.10 |
| **Total** | | **≈ $0.10 / month** | **≈ $0.12 / month** |

### One test cycle (deploy → run all 4 experiments → destroy, ~1–2 h)

| Service | Usage assumption | us-east-1 | ap-northeast-1 |
| ------- | ---------------- | --------- | -------------- |
| **FIS** | 4 experiments × 1 action × ~5 action-minutes = **~20 action-minutes** @ $0.10 | **$2.00** | **$2.00** |
| Lambda | ~a few thousand invocations, 256 MB, <300 ms | <$0.02 | <$0.02 |
| DynamoDB | a few thousand read/write request units | <$0.01 | <$0.01 |
| API Gateway HTTP API | a few thousand requests @ $1.00–$1.11 / million | <$0.01 | <$0.01 |
| CloudFront | a few thousand HTTPS requests + <1 GB out (within Free Tier) | ~$0.00 | ~$0.00 |
| CloudWatch Logs | experiment + access + function logs, well under 1 GB @ $0.50 / $0.76 per GB | <$0.05 | <$0.05 |
| **Total per cycle** | | **≈ $2.10** | **≈ $2.10** |

**Key correction vs. earlier versions of this doc:** FIS is **not free**. It bills **$0.10 per action-minute** (same in both regions); an "action-minute" is one minute of one running action. A 5-minute single-action experiment costs ~$0.50; running B-1 through B-4 once costs ~$2.00. Experiment reports (opt-in) are an extra $5 each and are not used here.

Pricing references (list price, retrieved via the AWS Price List API, Sep 2026):
FIS `ActionMinute` $0.10 (both regions) · Lambda / DynamoDB / API GW near-identical between the two regions · CloudWatch alarm $0.10 · CloudWatch Logs ingestion $0.50/GB (us-east-1) vs $0.76/GB (ap-northeast-1).

## Security Considerations

- **Lambda execution role — least privilege**: `dynamodb:GetItem/PutItem/DeleteItem/Scan` on the specific table (via `table.grantReadWriteData()`), plus `s3:GetObject`/`s3:ListBucket` scoped to the `FisConfigs/` prefix of the config bucket (for the extension).
- **FIS role — least privilege**: `s3:PutObject`/`s3:DeleteObject` scoped to `<bucket>/FisConfigs/*`; `lambda:GetFunction` and `tag:GetResources` (target resolution); `cloudwatch:DescribeAlarms` on the one stop-condition alarm; CloudWatch Logs delivery actions. No `lambda:UpdateFunctionConfiguration`, no DynamoDB access.
- **FIS config bucket**: all public access blocked, S3-managed encryption, TLS enforced, 1-day object expiry so stale fault configs do not linger.
- **No VPC exposure**: no VPC, subnet or security group. The only surface is the CloudFront / API GW public endpoint — appropriate for a public demo API. For production add a Cognito or IAM authorizer to the route.
- **Stop condition is mandatory**: every template carries the Lambda-error alarm stop condition, bounding the maximum blast radius.

## Troubleshooting

| Symptom | Likely cause | Resolution |
| ------- | ------------ | ---------- |
| `cdk deploy` fails: `No parameters found for environment` | Missing `dev-params.ts` registration | Verify `parameters/index.ts` imports `dev-params` and it calls `params[Environment.DEVELOPMENT] = …` |
| FIS template create fails: `Invalid actionId ... 404` | An action ID that does not exist in the Region | Check `aws fis list-actions` |
| FIS template create fails: `The service parameter value is not supported for the action` | `aws:fis:inject-api-*` with an unsupported `service` (e.g. `dynamodb`) | Use the `aws:lambda:function` actions instead (as this workspace does) |
| Experiment runs but the API never returns errors | Function is missing the FIS extension layer / env vars, or the S3 config bucket is unreachable | Confirm the layer + `AWS_LAMBDA_EXEC_WRAPPER` + `AWS_FIS_CONFIGURATION_LOCATION`; check the function log for `AWS FIS EXTENSION` lines |
| Errors take ~1 minute to appear | Expected — extension slow-poll ramp-up | Wait ~60 s; for partial-% scenarios allow 2–3 min |
| Experiment stops immediately | Stop-condition alarm already in `ALARM` | `aws cloudwatch set-alarm-state --alarm-name <name> --state-value OK --state-reason reset` |

## Clean-up

```bash
PROJECT=<project> ENV=dev npm run stage:destroy:all -w workspaces/fis-arch-b-apigw-lambda -- --force
```

All resources use `removalPolicy: DESTROY` (and `autoDeleteObjects` on the S3 config bucket), so destroy removes the DynamoDB table, Lambda, API GW, CloudFront distribution, FIS templates, S3 config bucket and CloudWatch log groups completely.

## Summary

This workspace demonstrates FIS chaos engineering on a serverless CRUD API using the `aws:lambda:function` action family and the AWS FIS Lambda extension:

- **B-1** — fail-fast total outage (handler never runs): does the front end degrade cleanly?
- **B-2** — +10 s invocation latency: are timeout budgets and latency alarms correct?
- **B-3** — 50% fail-after-execution: is the write path idempotent under client retries?
- **B-4** — synthetic 500 integration response: does API GW / CloudFront error mapping behave?

The serverless architecture keeps steady-state cost at ~$0.10/month; a full four-experiment test cycle costs about **$2** and is dominated by FIS action-minute charges.

## References

- [AWS FIS — Actions reference](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [Use the AWS FIS `aws:lambda:function` actions](https://docs.aws.amazon.com/fis/latest/userguide/use-lambda-actions.html)
- [Available versions of the AWS FIS extension for Lambda](https://docs.aws.amazon.com/fis/latest/userguide/actions-lambda-extension-arns.html)
- [AWS FIS pricing](https://aws.amazon.com/fis/pricing/)
- [CDK `aws-fis` module (L1 constructs)](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_fis-readme.html)
- [API Gateway HTTP API — Lambda integration](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html)
