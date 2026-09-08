# FIS Chaos Engineering — Architecture B: CloudFront + API Gateway HTTP API + Lambda + DynamoDB

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20CloudFront%20%7C%20API%20Gateway%20%7C%20Lambda%20%7C%20DynamoDB-orange?style=flat-square)

## Introduction

This project is a reference implementation for AWS Fault Injection Simulator (FIS) chaos engineering on a **serverless web API** architecture. A single CloudFront distribution routes all traffic through an API Gateway HTTP API to a Python Lambda function, which reads and writes a DynamoDB table.

Four FIS experiment templates inject distinct failure modes at the DynamoDB and Lambda layers, covering the realistic failure scenarios operators need to validate before production:

| Scenario | Fault Injected | Duration | What It Validates |
| -------- | -------------- | -------- | ----------------- |
| **B-1** DynamoDB Internal Error | `InternalError` on all DynamoDB operations | 5 min | Lambda retry/backoff logic, 500 propagation through API GW and CloudFront |
| **B-2** DynamoDB Write Throttle | `ProvisionedThroughputExceededException` on PutItem + DeleteItem | 5 min | Write-path circuit-breaker patterns; read operations remain healthy |
| **B-3** DynamoDB Read Throttle | `ProvisionedThroughputExceededException` on GetItem + Scan | 5 min | Read-path fallback / graceful degradation; writes remain healthy |
| **B-4** Lambda Concurrency Zero | Reserved concurrency set to 0 for the API function | 5 min | API GW error mapping and CloudFront custom-error-page fallback |

All experiments share a CloudWatch Alarm stop condition that automatically halts the experiment if the Lambda error count exceeds 10 per minute, providing a safety net against extended outages.

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
    │  GetItem / PutItem / DeleteItem / Scan
    ▼
DynamoDB Table  (PAY_PER_REQUEST, string partition key: id)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIS Experiment Templates (FisStack)

B-1  aws:fis:inject-api-internal-error ──────► Lambda execution role
     service=dynamodb, ops=GetItem,PutItem,DeleteItem,Scan, 100%, 5m

B-2  aws:fis:inject-api-throttle-error ─────► Lambda execution role
     service=dynamodb, ops=PutItem,DeleteItem, 100%, 5m

B-3  aws:fis:inject-api-throttle-error ─────► Lambda execution role
     service=dynamodb, ops=GetItem,Scan, 100%, 5m

B-4  aws:lambda:put-function-concurrent-executions ► Lambda function
     ConcurrentExecutions=0, 5m
```

### Key Design Benefits

| Feature | Benefit |
| ------- | ------- |
| No VPC required | Fully serverless — no NAT Gateway, no subnet planning, no VPC hourly charges |
| `aws:fis:inject-api-*` targets IAM role | FIS intercepts outbound DynamoDB calls by the Lambda execution role; the function code is untouched |
| Distinct B-2 / B-3 scenarios | Write-only throttle vs. read-only throttle reveal asymmetric fallback behavior that a "throttle all" test would miss |
| Shared stop condition | One CloudWatch Alarm (≥ 10 Lambda errors / min) halts any of the four experiments automatically |
| CloudFront as stable front door | Stable domain, WAF attachment point, and a natural place to observe 4xx/5xx rates during experiments |

## Prerequisites

- AWS CLI v2 installed and configured
- Node.js 20 or later
- AWS CDK CLI (`npm install -g aws-cdk`)
- Basic knowledge of TypeScript and Python
- AWS account with FIS service-linked role created (auto-created on first FIS use)

> **No VPC or NAT Gateway costs**: this architecture uses only serverless services. The dominant ongoing cost at rest is zero (DynamoDB PAY_PER_REQUEST, Lambda invocations).

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
│       ├── app-stack.ts                   # Lambda + API GW HTTP API + CloudFront
│       └── fis-stack.ts                   # 4 FIS experiment templates + IAM + alarms
├── parameters/
│   ├── environments.ts                    # Environment parameter type
│   ├── dev-params.ts                      # Development environment parameters
│   └── index.ts                           # Parameter exports
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts               # cdk-nag AwsSolutions compliance checks
│   └── snapshot/
│       └── snapshot.test.ts              # CDK snapshot tests (12 test cases)
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
CloudFront Distribution
  │  Cache-disabled (CACHING_DISABLED policy)
  │  ALL_VIEWER_EXCEPT_HOST_HEADER origin request policy
  ▼
API Gateway HTTP API  (/items, /items/{id})
  │  Lambda proxy integration — entire HTTP request forwarded
  ▼
Lambda Function (Python 3.13)
  ├── GET  /items          → table.scan()
  ├── POST /items          → table.put_item()  (body: {"name": "...", "value": "..."})
  ├── GET  /items/{id}     → table.get_item()
  └── DELETE /items/{id}  → table.delete_item()
  ▼
DynamoDB Table  (partition key: id, string UUID generated by Lambda on POST)
```

### FIS Injection Point

`aws:fis:inject-api-*` actions intercept outbound AWS API calls **made by a specified IAM role**. Because the Lambda execution role is the target, every DynamoDB call from inside the Lambda function receives the injected error — the function code itself is never modified. This is why B-1/B-2/B-3 target `aws:iam:role` (the Lambda execution role ARN), not `aws:dynamodb:table`.

## Key Components and Design Points

| Component | Design Points |
| --------- | ------------- |
| DynamoDB Table | PAY_PER_REQUEST billing; costs zero at rest; PITR disabled for minimal cost during experiments |
| Lambda Function | Python 3.13, 256 MB, 29 s timeout (1 s under API GW's 30 s limit) |
| API Gateway HTTP API | Default stage, access logging to CloudWatch Logs, no custom authorizer (public demo) |
| CloudFront Distribution | `CACHING_DISABLED` cache policy, `ALL_VIEWER_EXCEPT_HOST_HEADER` origin request policy (passes all query strings and headers to API GW) |
| FIS IAM Role | Minimal: `fis:InjectApiInternalError` + `fis:InjectApiThrottleError` on the Lambda exec role; `lambda:PutFunctionConcurrency` + `lambda:DeleteFunctionConcurrency` on the Lambda function; `cloudwatch:DescribeAlarms` on the stop-condition alarm |
| CloudWatch Stop Alarm | `LambdaErrors >= 10` over 1 minute — shared by all 4 templates |
| FIS Log Group | `/fis/{project}-{env}-b` — ONE_MONTH retention, auto-deleted on stack destroy |

## Implementation Highlights

### 1. Lambda CRUD handler for DynamoDB

The Lambda function is intentionally simple — it exists as a target for FIS fault injection, not as a production-grade service:

```python
# lambda/api-handler/index.py (excerpt)
TABLE_NAME = os.environ["TABLE_NAME"]
table = boto3.resource("dynamodb").Table(TABLE_NAME)

def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path   = event.get("rawPath", "/items")
    item_id = path.split("/items/", 1)[1] if "/items/" in path else None

    if method == "GET" and not item_id:
        result = table.scan()
        return ok(result.get("Items", []))
    elif method == "POST":
        body = json.loads(event.get("body") or "{}")
        item = {"id": str(uuid.uuid4()), **body}
        table.put_item(Item=item)
        return ok(item, 201)
    # ... GET /{id} and DELETE /{id}
```

The function propagates DynamoDB exceptions directly to API Gateway as HTTP 500 (or 429 for throttles), so the experiment's effect is immediately visible in CloudWatch metrics and in the API's HTTP response code distribution.

### 2. FIS API error injection targets the Lambda execution role

The key to understanding B-1, B-2, and B-3 is that `aws:fis:inject-api-*` actions target an **IAM role**, not a resource:

```typescript
// lib/stacks/fis-stack.ts (excerpt — scenario B-1)
const lambdaExecRoleArn = props.apiFunction.role!.roleArn;

targets: {
    LambdaExecRole: {
        resourceType: 'aws:iam:role',
        resourceArns: [lambdaExecRoleArn],  // the Lambda execution role
        selectionMode: 'ALL',
    },
},
actions: {
    InjectDynamoInternalError: {
        actionId: 'aws:fis:inject-api-internal-error',
        parameters: {
            service: 'dynamodb',
            operations: 'GetItem,PutItem,DeleteItem,Scan',
            percentage: '100',
            duration: 'PT5M',
        },
        targets: { Roles: 'LambdaExecRole' },
    },
},
```

FIS intercepts every call the Lambda function makes to DynamoDB and returns `InternalError` instead. No code change, no mocking, no VPC traffic manipulation — the injection happens at the AWS control plane.

### 3. Scenario B-2 vs. B-3: asymmetric throttle scenarios

Scenarios B-2 and B-3 inject throttle errors on complementary operation sets:

```typescript
// B-2: write-only throttle — reads (GetItem/Scan) remain healthy
parameters: {
    service: 'dynamodb',
    operations: 'PutItem,DeleteItem',   // writes only
    percentage: '100',
    duration: 'PT5M',
},

// B-3: read-only throttle — writes (PutItem/DeleteItem) remain healthy
parameters: {
    service: 'dynamodb',
    operations: 'GetItem,Scan',         // reads only
    percentage: '100',
    duration: 'PT5M',
},
```

This is intentional: real production DynamoDB throttling often hits one dimension (writes or reads) before the other. Running both experiments reveals whether the application falls back gracefully when reads fail (does it serve cached data?) vs. when writes fail (does it queue retries?).

### 4. Scenario B-4: Lambda concurrency exhaustion

B-4 uses a different FIS mechanism — it directly manipulates the Lambda function's **reserved concurrency**:

```typescript
// B-4: set reserved concurrency to 0 for 5 minutes
targets: {
    ApiFunction: {
        resourceType: 'aws:lambda:function',
        resourceArns: [props.apiFunction.functionArn],
        selectionMode: 'ALL',
    },
},
actions: {
    SetConcurrencyZero: {
        actionId: 'aws:lambda:put-function-concurrent-executions',
        parameters: {
            ConcurrentExecutions: '0',
            duration: 'PT5M',
        },
        targets: { Functions: 'ApiFunction' },
    },
},
```

With `reservedConcurrency: 0`, all Lambda invocations immediately return `TooManyRequestsException` (HTTP 429) without executing. API Gateway maps this to a `429` or `502` response depending on integration configuration. CloudFront, if configured with a custom error page for 4xx/5xx codes, should surface a user-friendly fallback.

### 5. Shared stop condition and automatic recovery

All four templates reference the same CloudWatch Alarm:

```typescript
const lambdaErrorAlarm = new cw.Alarm(this, 'LambdaErrorAlarm', {
    metric: props.apiFunction.metricErrors({
        period: cdk.Duration.minutes(1),
        statistic: 'Sum',
    }),
    threshold: 10,
    evaluationPeriods: 1,
    comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cw.TreatMissingData.NOT_BREACHING,
});

const stopConditions = [{
    source: 'aws:cloudwatch:alarm',
    value: lambdaErrorAlarm.alarmArn,
}];
```

If the error rate exceeds the safety threshold, FIS stops the experiment and the Lambda execution role reverts to normal operation. The alarm also sends a notification to the SNS topic (with optional email subscription via `alarmEmail` parameter).

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
PROJECT=fis-chaos-b ENV=dev npm run bootstrap
```

### 4. Deploy all stacks

```bash
PROJECT=fis-chaos-b ENV=dev npm run stage:deploy:all
```

This deploys the three stacks in dependency order:
1. `fis-chaos-b-dev-b-base` — DynamoDB table
2. `fis-chaos-b-dev-b-app` — Lambda + API GW + CloudFront
3. `fis-chaos-b-dev-b-fis` — FIS templates + IAM + alarms

### 5. Test the API

After deployment, retrieve the CloudFront domain from the stack output:

```bash
# List items
curl https://<cloudfront-domain>/items

# Create an item
curl -X POST https://<cloudfront-domain>/items \
  -H 'Content-Type: application/json' \
  -d '{"name":"test","value":"hello"}'

# Get one item
curl https://<cloudfront-domain>/items/<id>

# Delete an item
curl -X DELETE https://<cloudfront-domain>/items/<id>
```

### 6. Run a FIS experiment

Navigate to the AWS FIS console, select one of the four experiment templates (`B-1` through `B-4`), click **Start experiment**, and observe the Lambda error count in CloudWatch.

## Testing

```bash
cd infrastructure
npm ci

# Run all tests for this workspace
npm run test --workspace=fis-arch-b-apigw-lambda

# Snapshot tests only (12 test cases across 3 stacks)
npm run test:snapshot --workspace=fis-arch-b-apigw-lambda

# CDK Nag compliance checks
npm run test:compliance --workspace=fis-arch-b-apigw-lambda

# Update snapshots after intentional changes
npm run test:snapshot:update --workspace=fis-arch-b-apigw-lambda
```

### What the tests cover

| Test suite | File | Assertions |
| ---------- | ---- | ---------- |
| Snapshot | `test/snapshot/snapshot.test.ts` | Full CFn template snapshots for all 3 stacks; DynamoDB PAY_PER_REQUEST; Lambda Python 3.13; CloudFront distribution count; API GW HTTP API count; exactly 4 FIS templates; all templates have stop conditions |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutions pack — no unsuppressed warnings or errors |

## Cost Estimation

All services are serverless (pay-per-use), so the cost at rest is effectively **zero**.

| Service | Billing Model | Estimated cost during experiments |
| ------- | ------------- | --------------------------------- |
| DynamoDB | PAY_PER_REQUEST | ~$0 at idle; <$0.01 for a few hundred test requests |
| Lambda | Per invocation + duration | <$0.01 for 5-minute experiment at 10 req/s |
| API Gateway HTTP API | Per request | <$0.01 for 5-minute experiment |
| CloudFront | Per request + data transfer | <$0.01 |
| CloudWatch | Metrics + logs | ~$0.01/month for experiment logs |
| FIS | Free | No charge for FIS itself |
| **Total (experiments only)** | | **< $0.10 per experiment run** |

## Security Considerations

- **Lambda execution role follows least privilege**: the role only has `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:DeleteItem`, and `dynamodb:Scan` on the specific table (granted via `table.grantReadWriteData()`).
- **FIS role follows least privilege**: scoped to `fis:InjectApiInternalError` / `fis:InjectApiThrottleError` on the Lambda execution role ARN, and `lambda:PutFunctionConcurrency` / `lambda:DeleteFunctionConcurrency` on the specific Lambda function ARN.
- **No VPC exposure**: there is no VPC, no public subnet, and no security group — the attack surface is the CloudFront/API GW public endpoint, which is appropriate for a public demo API.
- **API is unauthenticated by design**: this reference pattern focuses on FIS behavior. For production, add a Cognito authorizer or IAM auth to the API Gateway route.
- **Stop condition is mandatory**: all FIS templates include the Lambda error alarm stop condition, which limits maximum experiment blast radius.

## Troubleshooting

| Symptom | Likely cause | Resolution |
| ------- | ------------ | ---------- |
| `cdk deploy` fails with `No parameters found for environment` | Missing `dev-params.ts` export | Verify `parameters/index.ts` exports `devParams` under the `dev` key |
| Lambda returns 500 during B-1 experiment | Expected — FIS is injecting `InternalError` | Check CloudWatch Lambda metrics; verify experiment is running |
| FIS experiment stops immediately | Stop condition alarm is already in `ALARM` state | Reset the alarm first (`aws cloudwatch set-alarm-state --alarm-name ... --state-value OK`) |
| CloudFront returns 403 on API calls | Missing `ALL_VIEWER_EXCEPT_HOST_HEADER` origin request policy | Verify the CloudFront distribution behavior includes the policy |
| `Table not found` Lambda error | BaseStack not yet deployed | Deploy stacks in order: Base → App → FIS |

## Clean-up

```bash
PROJECT=fis-chaos-b ENV=dev npm run stage:destroy:all
```

All resources have `removalPolicy: DESTROY`, so the destroy command removes the DynamoDB table, Lambda, API GW, CloudFront distribution, FIS templates, and CloudWatch log groups completely.

## Summary

This workspace demonstrates FIS chaos engineering on a serverless CRUD API architecture. The four scenarios cover distinct failure modes:

- **B-1** verifies that the application fails safely when the data layer is completely unavailable.
- **B-2** verifies write-path resilience while reads remain healthy — a common DynamoDB capacity pattern.
- **B-3** verifies read-path resilience (cache fallback, graceful degradation) while writes remain healthy.
- **B-4** verifies the API tier's behavior when Lambda cannot execute at all, testing CloudFront's error-page capability.

The serverless architecture keeps experiment costs minimal (< $0.10 per run) and eliminates VPC management overhead, making it easy to iterate quickly on resilience scenarios.

## References

- [AWS FIS — Supported actions](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [aws:fis:inject-api-internal-error action reference](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-fis)
- [aws:lambda:put-function-concurrent-executions action reference](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-lambda)
- [CDK aws-fis module (L1 constructs)](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_fis-readme.html)
- [API Gateway HTTP API — Lambda integration](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html)
