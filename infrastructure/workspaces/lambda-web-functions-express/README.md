# Lambda Web Functions (Express.js) behind CloudFront + OAC - AWS CDK Reference Architecture

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

The Todos REST API from the `apigw-*` comparison series, served by **a plain Express.js HTTP server running as an AWS Lambda Web Function** (GA 2026-10-12). There is no API Gateway, no Lambda Web Adapter layer and no `handler(event)`: the server calls `app.listen()` on the address in `AWS_LAMBDA_HTTP_ENDPOINT`, and Lambda provides the HTTPS endpoint, scaling (including to zero) and multi-concurrent execution environments.

The endpoint uses `IamAuth`, and CloudFront signs every origin request with **origin access control (OAC)**, so the endpoint domain rejects anything that does not come through this distribution. AWS WAF is attached at CloudFront, because a Web Function endpoint has no WAF of its own.

This is the fourth workspace that implements **the same API** so the Lambda integration styles can be compared directly:

| Workspace | Front door | Functions | Routing | One-liner |
|-----------|-----------|-----------|---------|-----------|
| [`apigw-single-purpose-lambda`](../apigw-single-purpose-lambda/) | API Gateway | one per route | API Gateway | Maximum isolation: one function, role and permission set per route. |
| [`apigw-lambdalith`](../apigw-lambdalith/) | API Gateway | one | Hono (in-process) | One function, one deploy unit, framework routing. |
| [`apigw-lambda-web-adapter`](../apigw-lambda-web-adapter/) | API Gateway | one | Express (in-process) | Standard Express server behind the Lambda Web Adapter layer. |
| **`lambda-web-functions-express`** (this) | **CloudFront + Web Function endpoint** | **one Web Function** | **Express (in-process)** | **Same Express app, no adapter and no API Gateway; one environment serves many requests at once.** |

## 📑 Table of Contents

- [Architecture Overview](#️-architecture-overview)
- [How Lambda Web Functions Work](#-how-lambda-web-functions-work)
- [Design Decisions & Best Practices](#-design-decisions--best-practices)
- [Pattern Comparison](#-pattern-comparison)
- [Verification Results (deployed to ap-northeast-1)](#-verification-results-deployed-to-ap-northeast-1)
- [Well-Architected Alignment](#️-well-architected-alignment)
- [Cost Optimization](#-cost-optimization)
- [Security Considerations](#-security-considerations)
- [Prerequisites](#-prerequisites)
- [Deployment Guide](#-deployment-guide)
- [Usage](#usage)
- [Testing Strategy](#-testing-strategy)
- [Customization](#️-customization)
- [Troubleshooting](#-troubleshooting)
- [Clean-up](#-clean-up)
- [References](#-references)

## 🏗️ Architecture Overview

![Architecture Diagram](overview.drawio.svg)

### Key Components

- **AWS Lambda Web Function** (`AWS::Lambda::WebFunction` / `WebFunctionRevision` / `WebFunctionEndpoint`). The function is only a name; the **revision** is an immutable snapshot of code + configuration (`nodejs24.x`, arm64, timeout 30 s, `maxConcurrencyPerEnvironment` 64, environment variables, logging); the **endpoint** (`HomeRegion`, `IamAuth`) routes 100% of traffic to the revision and carries the scaling caps (`maxEnvironments` 3, `rateLimit` 100 RPS in dev).
- **Express app (`src/`)**. The same routes as `apigw-lambda-web-adapter`, plus request validation, `helmet` security headers and JSON error handling that used to be (or could be) API Gateway's job. `src/index.ts` only binds `AWS_LAMBDA_HTTP_ENDPOINT`. `/debug/*` diagnostic routes (concurrency, CPU, SSE, background work) are mounted only when `enableDebugRoutes` is true.
- **Code bucket** (S3, versioned, SSE-S3, TLS-only). `BucketDeployment` with `extract: false` copies the esbuild bundle (`index.js` in a zip) under a content-hashed key, and the revision pins `key` + `versionId`. The bucket policy lets `lambda.amazonaws.com` read it only for `web-function/<name>/*` in this account.
- **Amazon CloudFront** with an **origin access control** (`lambda`, `always-amz-auth`, `sigv4`), `CachingDisabled` and `AllViewerExceptHostHeader`. An `AWS::Lambda::ResourcePolicy` on the Web Function allows `cloudfront.amazonaws.com` to call `lambda:InvokeWebFunctionEndpoint` on this endpoint only, with `aws:SourceArn` = this distribution.
- **AWS WAF** (separate stack in `us-east-1`, CLOUDFRONT scope): per-IP rate-based rule, `AWSManagedRulesCommonRuleSet`, `AWSManagedRulesKnownBadInputsRuleSet`, and an IP allow list (`ALLOWED_IPS`, or the deploying machine's global IP).
- **Amazon DynamoDB** (`TodosTable`): on-demand, SSE, PITR. The execution role gets `grantReadWriteData` on this table only.
- **Logging**: `/aws/lambda/web/<function-name>` and its per-Region `.local` companion, both pre-created with 1-week retention. Without the second one the service creates `.local` on first use with no retention, and it survives `cdk destroy` (verified). The execution role can write only to these two groups.
- **Optional VPC egress** (`vpcEgress.enabled`, off by default): an isolated VPC (no NAT, DynamoDB gateway endpoint only) and an `AWS::Lambda::NetworkConnector` (`VPC_EGRESS`, `WebFunction`) referenced by the revision. Verified: with it on, the app reaches DynamoDB but not the internet.

### Stacks

| Stack | Region | Contents |
|-------|--------|----------|
| `<project>-<env>-lambda-web-functions-express-waf` | us-east-1 | WAF Web ACL + IP sets |
| `<project>-<env>-lambda-web-functions-express` | ap-northeast-1 | Everything else (Web Function, bucket, CloudFront, DynamoDB, logs) |

## 🔌 How Lambda Web Functions Work

```
                 ┌──────────────── execution environment (2 vCPU / 2 GB, arm64) ────────────────┐
HTTPS request ─► │ Lambda routes the request to an environment with spare dynamic concurrency    │
(endpoint)       │   └─► node index.js  ──listen(AWS_LAMBDA_HTTP_ENDPOINT = 0.0.0.0:3000)──►     │
                 │        Express handles up to N requests concurrently in ONE process            │
                 └────────────────────────────────────────────────────────────────────────────────┘
```

| | Event Functions (+ Web Adapter) | **Web Functions** |
|---|---|---|
| Programming model | `handler(event)` or an adapter that converts events to HTTP | **a normal HTTP server that listens on a port** |
| Requests per environment | 1 at a time | **many at once** (dynamic limit, upper bound 1–128) |
| Front door | API Gateway / ALB / Function URL | **built-in HTTPS endpoint** (`ApplicationManaged` or `IamAuth`) |
| Compute billing | GB-seconds of wall-clock duration | **active CPU (vCPU-s) + consumed memory (GB-s) + requests** |
| Packaging | zip or container image, layers | **zip only, no layers**, Node.js (`nodejs24.x`) arm64 |
| Scale controls | reserved / provisioned concurrency | **`maxEnvironments`, `rateLimit`** on the endpoint |
| Event sources (SQS, Streams…) | yes | **no** — HTTP only |

The three resources map to three lifecycles:

- **Web Function** — a name (unique across *all* Regions of the account).
- **Revision** — immutable. Changing code, runtime, timeout, environment variables, concurrency or logging creates a new revision; CloudFormation replaces it.
- **Endpoint** — mutable. Auth type, revision weights (up to 2, for canaries), `maxEnvironments` and `rateLimit` update in place in a few seconds.

## 🎯 Design Decisions & Best Practices

### 1. `IamAuth` + CloudFront OAC instead of a public endpoint

An `ApplicationManaged` endpoint is public at its own domain even when CloudFront sits in front, and Lambda does not evaluate the resource policy for it. With `IamAuth`, CloudFront signs each origin request (`always-amz-auth` is the only signing behavior Web Function origins accept), the viewer's `Authorization` header is passed through untouched, and the resource policy restricts the caller to this distribution. Verified: an unsigned request straight to the endpoint domain returns **403**.

Two CloudFront settings are mandatory for this origin: `AllViewerExceptHostHeader` (forwarding the viewer `Host` makes the endpoint return 404), and, if the app reads the viewer `Authorization` header, adding it to the cache policy.

### 2. Generated L1 constructs, wrapped in one construct

`aws-cdk-lib` 2.273.0 generates `CfnWebFunction`, `CfnWebFunctionRevision` and `CfnWebFunctionEndpoint` (no L2 yet). [`lib/constructs/web-function.ts`](lib/constructs/web-function.ts) wraps them with the bucket, role and log group, and encodes the gotchas:

- Revision and endpoint reference the function by its **bare name** (an ARN later breaks reading the endpoint `DomainName`), which creates no CloudFormation reference, so `addResourceDependency` is required.
- `BucketDeployment.objectKeys` are **relative to `destinationKeyPrefix`** — the prefix must be prepended, otherwise `CreateWebFunctionRevision` fails with *"The specified S3 object does not exist"* (hit during the first deploy).
- The cfn-lint schema bundled with this aws-cdk-lib does not know the new types and reports `F3006 Unknown resource type`; it is acknowledged with `Validations.of(this).acknowledge(...)`.

### 3. Bundle to one `index.js` with esbuild

The runtime loads `index.js` at the zip root. esbuild bundles Express, `helmet` and the AWS SDK into a single CommonJS file (2.5 MB), so no `node_modules` or `package.json` (`"type": "module"`) is needed in the artifact, and arm64 compatibility is trivially satisfied (no native addons). Measured cold start: **445–520 ms total, 335 ms CPU, ~170 MB** (`platform.initReport`).

### 4. Move API Gateway's responsibilities into the app

Without API Gateway, request validation, CORS, security headers and per-client throttling are the application's job. This reference validates the body in `src/utils/validation.ts`, returns JSON 400 for malformed JSON, sets security headers with `helmet`, and relies on the WAF rate-based rule for per-IP limits (the endpoint `rateLimit` is endpoint-wide, not per client).

### 5. Thread-safety: module state is shared

One process serves many requests concurrently. Module-level variables are shared by all in-flight requests, so only immutable configuration and SDK clients belong there. The `/debug` routes intentionally keep environment-level counters (`inFlight`, `maxInFlight`) to make this visible.

### 6. Cap scale per environment (`maxEnvironments`, `rateLimit`)

`maxEnvironments` bounds cost and downstream load; `rateLimit` bounds the request rate (0 = kill switch, returns 503 `Platform.EndpointDisabled`). Both live on the endpoint and update in place. See the verification results for how `maxEnvironments` interacts with the *dynamic* per-environment concurrency limit — a small value throttles cold bursts.

### 7. VPC egress is a revision setting (and the L1 lags behind the schema)

The revision takes the **version-qualified** connector ARN (`attrLatestVersionArn`). The live CloudFormation schema has `ServiceConfig.EgressNetworkConnectorArn`, but the `CfnWebFunctionRevision` generated in aws-cdk-lib 2.273.0 does not expose it, so [`web-function.ts`](lib/constructs/web-function.ts) sets it with `addPropertyOverride` — CloudFormation accepted it and the revision came up bound to `...:network-connector:<id>:1`. The bundled cfn-lint also rejects `GetAtt LatestVersionArn` (E9004, an error with `validateAgainstDefaultRules`) and `AssociatedComputeResourceTypes: WebFunction` (W3030, it only knows `MicroVm`); both are acknowledged in the constructs. The connector takes ~4 minutes to create; adding or removing it replaces the revision without errors.

## 🔀 Pattern Comparison

| Aspect | Single-Purpose Lambda | Lambdalith (Hono) | Lambda Web Adapter | **Web Functions (this)** |
|--------|----------------------|-------------------|-------------------|--------------------------|
| Front door | API Gateway REST | API Gateway REST | API Gateway REST | **CloudFront → Web Function endpoint** |
| Lambda-specific code | handler per route | `hono/aws-lambda` entry | adapter layer + `run.sh` | **none (`listen()` on the given address)** |
| Requests per environment | 1 | 1 | 1 | **many (dynamic, ≤ 64 here)** |
| Compute billing | wall-clock GB-s | wall-clock GB-s | wall-clock GB-s | **active vCPU-s + consumed GB-s** |
| Response streaming | REST: no | REST: no | REST: no | **native (SSE verified through CloudFront)** |
| Background work after response | no (frozen) | no | no | **yes (verified)** |
| Canary / blue-green | aliases + CodeDeploy | aliases + CodeDeploy | aliases + CodeDeploy | **`revisionWeights` on the endpoint (2 revisions)** |
| Request validation / API keys / usage plans | API Gateway | API Gateway | API Gateway | **app / WAF (no usage plans)** |
| Provisioned Concurrency / SnapStart | yes | yes | yes | **no** |
| Runtimes / packaging | any / zip or image | any / zip or image | any / zip or image + layer | **Node.js 24 / zip, arm64** |
| Best fit | per-route isolation | small–medium API | porting a web app to Event Functions | **I/O-bound Node.js APIs, SSR, streaming, many concurrent waits** |

Keep API Gateway (in front of an Event Function, or in front of the Web Function endpoint as an HTTP integration) when you need usage plans and API keys, Cognito/Lambda authorizers, request/response mapping, mTLS or WebSocket APIs.

## 🔬 Verification Results (deployed to ap-northeast-1)

Measured on 2026-10-15 with [`test-api.sh`](test-api.sh) and ad-hoc load from a single client in Japan (through CloudFront NRT edge). Single runs — treat them as orders of magnitude, not benchmarks.

### Functional checks (`./test-api.sh`)

| Check | Result |
|-------|--------|
| `GET /health` via CloudFront | 200, `lambda-web-request-id` + `lambda-web-logstream` (contains `[rev-xxxxx]`) headers, `helmet` headers present |
| CRUD lifecycle | 201 / 200 / 200 / 200 / 204, then 404 for read and update of the deleted item |
| Validation | missing title, non-boolean `completed`, malformed JSON → 400; unknown route → 404 |
| Unsigned request to the endpoint domain | **403** (`You are not authorized to access this endpoint`) |
| SSE (10 events, 500 ms interval) through CloudFront | first event after **223 ms**, stream closed after 5.65 s — not buffered |
| Work after the response (`setTimeout` after `res.json`) | completed and logged, **still tagged with the original `requestId`** |

### Scaling and throttling

| Scenario | Observation |
|----------|-------------|
| 100 parallel I/O-bound requests (2 s wait), `maxEnvironments` 3, cold | **6–8 accepted, 92–94 → 429 `Platform.EndpointMaxEnvThrottle`**. Fresh environments started with a dynamic limit of ~2–3 concurrent requests, far below `maxConcurrencyPerEnvironment` 64. |
| Repeated bursts of 30, then 100, with `maxEnvironments` 3 | The dynamic limit ramped up: all 30 accepted from the 4th burst (14 in flight per environment), **all 100 accepted from the 5th burst (37 in flight per environment, still 3 environments)** |
| `maxEnvironments` cleared, 300 parallel | 5–6 environments, up to 49 in flight per environment; **429 `Platform.EndpointRequestThrottle`** (rateLimit 100) and **503 without `lambda-web-error-type`** (documented load shedding — retry with backoff) |
| CPU-bound (500 ms busy loop), 10 parallel | spread over **8 environments**, latency stayed ~0.62 s (the router avoids CPU-busy environments); at 30 parallel some requests serialized (max 1.7 s) |
| `rateLimit: 0` | 503 `Platform.EndpointDisabled` within ~3 s; restored in ~2 s |
| Idle scale-down | 9 → 3 environments within ~1 min of the load stopping; the last environment got `SIGTERM` ~6 min after the last request (scale to zero) |
| First request after ~22 min idle | **0.89 s** end-to-end through CloudFront (`platform.initReport` 430 ms), next request 0.086 s |
| Starting limit varies | right after a CloudFormation revision switch on a warm endpoint, 30 parallel ran on **1 environment (30 in flight)**; on a freshly created endpoint, 30 parallel gave 8 OK / 22 × 429 twice in a row |

**Take-away:** `maxEnvironments` × `maxConcurrencyPerEnvironment` is an upper bound, not the capacity you get on a cold burst. If clients burst, either leave `maxEnvironments` unset (or generous) or make clients retry 429/503 with backoff.

### Billing signal

From the `AWS/Lambda/Web` CloudWatch metrics for a 5-minute window dominated by the 2-second I/O-wait test: **`EnvironmentCPUTime` 4.6 s vs `EnvironmentActiveTime` 361.7 s (≈1.3%)**, `EnvironmentMaxMemoryUsage` 165–210 MB. Waiting on I/O costs memory-seconds, not vCPU-seconds.

### Compared with the Lambda Web Adapter version (same account, same client)

[`apigw-lambda-web-adapter`](../apigw-lambda-web-adapter/) (API Gateway REST → Event Function, 256 MB arm64) deployed next to this one, both with 20 items in DynamoDB, measured with a closed-loop load generator (10 s warm-up, 30 s measurement). End-to-end from the client: this pattern goes through CloudFront, the other one straight to API Gateway.

| Scenario | Web Functions (this) | Lambda Web Adapter |
|----------|---------------------|--------------------|
| `/health`, 2 concurrent (no throttling on either) | p50 **20.7 ms** / p99 32.2 ms, 92 rps | p50 38.0 ms / p99 80.8 ms, 51 rps |
| `/todos` (DynamoDB scan), 2 concurrent | p50 **33.9 ms** / p99 50.8 ms, 58 rps | p50 47.9 ms / p99 144.4 ms, 38 rps |
| `/health`, 8 concurrent | **422 rps**, all 200, 3 environments | 90 rps of 200 + **5,292 × 500** |
| `/todos`, 8 concurrent | **233 rps**, all 200, 4 environments | 92 rps of 200 + **3,484 × 500** |
| `/todos`, 50 concurrent (caps lifted, `rateLimit` 1000) | 789–823 rps, 29 environments, 429 `EndpointRequestThrottle` + some 503 | — |

The LWA 500s are API Gateway's answer to Lambda throttling: this account's **Event Functions limit is 10 concurrent executions** (and ~100 synchronous invokes per second), while **Web Functions have their own quotas** (`maxTotalArmVCpus` 200, `maxTotalRateLimit` 10,000 RPS from `GetWebAccountSettings`). Over the benchmark window, compute per request was 2.5 ms of CPU on Web Functions versus 15.6 ms of billed duration on the Event Function. Per million requests that is about **$0.45** for the Web Function (requests + CPU + memory, including the 29 environments left idle after the 50-concurrent run) versus **$0.25 for the Event Function plus $4.25 for API Gateway** — the saving comes from dropping API Gateway, not from cheaper compute.

### Other behavior verified

| Check | Result |
|-------|--------|
| SSE longer than `timeoutSeconds` (40 events at 1 s, timeout 30 s) | **cut after 30 events with HTTP 200 and a clean end of stream** (curl exit 0) — the client cannot tell. Set `timeoutSeconds` (and CloudFront `readTimeout`) above the longest stream |
| Log delivery delay (`ingestionTime − timestamp`) | `.local` group 2.8–9.0 s, main group 7.1–15.4 s |
| `SIGTERM` with `server.close()` | `platform.spinDownReport` **success in 25–60 ms** |
| Account quotas (`GetWebAccountSettings`) | `maxTotalArmVCpus` 200, `maxTotalRateLimit` 10,000 — lower than the documented defaults (2,000 / 100,000); check before load testing |
| VPC egress on | connector created in 4 min 14 s; CRUD over the gateway endpoint OK; `/debug/egress` to the internet **timed out** |
| VPC egress removed (redeploy under a 5 req/s probe) | 61 s, **590/590 probe requests returned 200**, internet reachable again |
| After `cdk destroy` | an environment that outlived the deleted function emitted `platform.invokeSummary` ~2.5 min later and the replicated log **recreated `/aws/lambda/web/<name>`** without retention — see Clean-up |

### Deployments

| Operation | Time / result |
|-----------|---------------|
| First deploy of the main stack (incl. CloudFront) | 169 s |
| Code change via `cdk deploy` (new revision → endpoint switch → old revision deleted) | 76 s total (revision 5 s, endpoint 4 s); **790/790 probe requests returned 200**, traffic shifted gradually over ~4 s |
| Canary via API: new revision active | 5.5 s; 90/10 weights applied in 2.9 s; **22/233 sampled responses (9.4%)** served by the canary; rollback to 100% in 3.5 s |
| First deploy with VPC egress | 458 s (connector 4 min 14 s) |

## 🏛️ Well-Architected Alignment

| Pillar | Implementation |
|--------|---------------|
| **Operational Excellence** | One artifact, one revision per deploy; identical local and Lambda code path (`npm start`); structured platform logs with `requestId`; `AWS/Lambda/Web` metrics; `test-api.sh` operational check; canary/rollback by endpoint weights. |
| **Security** | `IamAuth` endpoint reachable only via CloudFront OAC + resource policy scoped by `aws:SourceArn`; WAF (managed rules, per-IP rate limit, IP allow list); `helmet` headers; app-level input validation; least-privilege role (one table, own log groups); TLS-only versioned code bucket; no secrets in revision environment variables. |
| **Reliability** | Managed multi-AZ endpoint; immutable revisions with weighted shifting and instant rollback; zero-error code deploy verified; DynamoDB PITR; documented 429/503 retry behavior. |
| **Performance Efficiency** | Many concurrent requests per environment for I/O-bound work; CPU-aware routing; native streaming; arm64; single 2.5 MB bundle (≈0.5 s init). |
| **Cost Optimization** | Billing on active CPU and consumed memory; scale to zero; `maxEnvironments` / `rateLimit` caps; on-demand DynamoDB; no API Gateway per-request charge. |
| **Sustainability** | Graviton; fewer environments for the same I/O-bound traffic; scale to zero. |

## 💰 Cost Optimization

### Unit prices (ap-northeast-1, from the AWS Price List API, 2026-10)

| Item | Price |
|------|-------|
| Web Functions requests | $0.30 / 1M |
| Web Functions active CPU (arm64) | $0.0000322421 / vCPU-second |
| Web Functions memory (arm64) | $0.0000042688 / GB-second |
| *Event Functions (arm64), for comparison* | $0.20 / 1M requests, $0.0000133334 / GB-second |
| *API Gateway REST / HTTP API, for comparison* | $4.25 / 1M (first 333M) / $1.29 / 1M (first 300M) |

### Estimated Monthly Costs

Assumptions: average 5 ms active CPU per request (in line with the measurement above), ~200 MB consumed memory per environment, free tiers excluded.

#### Light usage (~100,000 requests/month)
```
Web Functions requests:   100,000 x $0.30 / 1M                         = $0.03
Web Functions CPU:        100,000 x 5 ms = 500 vCPU-s                  = $0.02
Web Functions memory:     ~50 environment-hours x 0.2 GB = 36,000 GB-s = $0.15
CloudFront (Japan):       100,000 HTTPS req                            ≈ $0.12
AWS WAF:                  1 Web ACL + 4 rules + requests               ≈ $9.06
DynamoDB on-demand / CloudWatch Logs                                   ≈ $0.12
-----------------------------------------------------------------------------
Total:                                                                  ~$9.5/month (≈ $0.44 without WAF)
```

#### Moderate usage (~5,000,000 requests/month)
```
Web Functions requests:   5,000,000 x $0.30 / 1M                       = $1.50
Web Functions CPU:        5,000,000 x 5 ms = 25,000 vCPU-s             = $0.81
Web Functions memory:     ~1 environment always on: 518,400 GB-s       = $2.21
CloudFront (Japan):       5,000,000 HTTPS req + ~5 GB out              ≈ $6.57
AWS WAF:                  1 Web ACL + 4 rules + 5M requests            ≈ $12.00
DynamoDB on-demand:       ~15M RRU/WRU                                 ≈ $5.00
CloudWatch Logs:          ~2 GB                                        ≈ $1.50
-----------------------------------------------------------------------------
Total:                                                                  ~$29.6/month
```

For the same 5M requests, the compute + front-door part is **≈ $4.5** here versus **≈ $23** for `apigw-lambda-web-adapter` (REST API $21.25 + Lambda $1.80, no WAF). WAF and CloudFront are the largest items in this pattern; they buy L7 protection and the OAC lock-down.

*(Verify with the [AWS Pricing Calculator](https://calculator.aws/). Memory is charged for the whole life of each environment, including idle time between requests; a pattern that keeps one environment warm all month costs ~$2.2/month in memory alone.)*

### Cost notes specific to this pattern

1. **I/O-bound is the sweet spot.** Time spent waiting on DynamoDB or another API consumes memory-seconds but almost no vCPU-seconds, and many such requests share one environment.
2. **CPU-bound work gives the advantage back.** Busy CPU is billed per vCPU-second and Node uses one of the two vCPUs per process; for sustained CPU-heavy traffic compare Lambda Managed Instances.
3. **`maxEnvironments` is a cost cap**, but a small value throttles cold bursts (see verification).

## 🔒 Security Considerations

### Implemented

- `IamAuth` endpoint + CloudFront OAC (`always-amz-auth`) + `AWS::Lambda::ResourcePolicy` limited to this distribution (`aws:SourceArn`) and this endpoint ARN. Direct access returns 403.
- AWS WAF on CloudFront: per-IP rate-based rule, Core rule set, Known bad inputs, IP allow list (default block).
- Security headers via `helmet`; JSON body limit 64 KB; schema checks in the app; generic 500 bodies.
- Execution role: DynamoDB read/write on one table; `logs:*` actions only on `/aws/lambda/web/<name>` and `.local`.
- Code bucket: versioned, SSE-S3, block public access, TLS-only, Lambda read access only for this account's `web-function/<name>/*`.
- Debug routes are disabled outside `dev` (`enableDebugRoutes`).

### Intentionally out of scope (add per environment)

- **Authentication/authorization** — the endpoint trusts CloudFront, not end users. Validate a JWT/session in Express (forward `Authorization` by adding it to the cache policy), or keep API Gateway authorizers in front.
- **Secrets** — `get-web-function-revision` returns environment variables in plaintext to anyone with read access (verified). Store secrets in Secrets Manager / Parameter Store and fetch at runtime.
- **Customer-managed KMS** for the revision (`kmsKeyArn`) and the log group.
- Custom domain + ACM certificate, CloudFront access logs, geo restriction.

### CDK Nag

`AwsSolutionsChecks` passes for both stacks. Suppressions (in `test/compliance/cdk-nag.test.ts`) cover CDK-managed custom-resource handlers (IAM4, L1), log-stream / DynamoDB index wildcards (IAM5), the code bucket's access logs (S1) and CloudFront logging/geo/TLS-with-default-certificate (CFR1/3/4).

## 📋 Prerequisites

- AWS account in a Region where Lambda Web Functions is available (us-east-1, us-east-2, us-west-2, ap-northeast-1, eu-west-1 at launch); CDK bootstrapped in that Region **and in us-east-1** (WAF stack)
- AWS CLI v2 configured with a profile named `${PROJECT}-${ENV}`. `aws lambda-web` subcommands need a CLI release that includes the GA API (2.37.12 only exposes `get-web-account-settings`); boto3 ≥ 1.43 works as well — note that its parameters are camelCase (`functionName`)
- Check the account quotas before load testing: `GetWebAccountSettings` (`maxTotalArmVCpus`, `maxTotalRateLimit`). The vCPU quota is shared by every Web Function in the account and Region
- Node.js 22+ and `aws-cdk-lib` ≥ 2.273.0 (generated `CfnWebFunction*`)
- `curl` and `jq` for `test-api.sh`
- Docker is **not** required (local esbuild bundling)

## 🚀 Deployment Guide

```bash
cd infrastructure
npm install

export PROJECT=myproject
export ENV=dev
# Optional: WAF allow list (defaults to this machine's global IPv4)
export ALLOWED_IPS=203.0.113.10

npm run bootstrap -w workspaces/lambda-web-functions-express          # first time, per account/region
cdk bootstrap aws://<account-id>/us-east-1 --profile ${PROJECT}-${ENV}  # WAF stack Region
npm run diff -w workspaces/lambda-web-functions-express
npm run stage:deploy:all -w workspaces/lambda-web-functions-express
```

Outputs: `DistributionUrl`, `EndpointDomainName`, `WebFunctionName`, `EndpointName`, `RevisionId`, `LogGroupName`, `TodosTableName`.

## Usage

```bash
URL="<DistributionUrl output>"

curl -s "$URL/health"                                                    # {"status":"ok"}
curl -s -X POST "$URL/todos" -H 'content-type: application/json' -d '{"title":"buy milk"}' | jq .
curl -s "$URL/todos" | jq .
curl -s -X PUT "$URL/todos/<todoId>" -H 'content-type: application/json' -d '{"title":"buy oat milk","completed":true}' | jq .
curl -s -i -X DELETE "$URL/todos/<todoId>"

# Streaming and multi-concurrency (dev only)
curl -N "$URL/debug/stream?count=5&intervalMs=500"
curl -s "$URL/debug/env" | jq .

# Full operational check
./test-api.sh --project myproject --env dev
./test-api.sh --project myproject --env dev --only concurrency --parallel 30
./test-api.sh --project myproject --env dev --throttle
```

### Run the same server locally

```bash
TABLE_NAME=<table> ENABLE_DEBUG_ROUTES=true npm start -w workspaces/lambda-web-functions-express   # http://localhost:8080
```

## 🧪 Testing Strategy

```
test/
├── compliance/cdk-nag.test.ts                 # AwsSolutions pack for both stacks
├── helpers/stack.ts                           # builds the stack with bundling skipped
├── parameters/test-params.ts                  # deterministic Environment.TEST params
├── snapshot/snapshot.test.ts                  # template + resource-count snapshots (main + WAF)
└── unit/
    ├── lambda-web-functions-express-stack.test.ts   # Web Function / bucket / OAC / resource policy / WAF assertions
    └── app.test.ts                                  # Express app in-process (supertest, mocked DynamoDB)
```

```bash
npm test -w workspaces/lambda-web-functions-express                 # 54 tests
npm run test:snapshot:update -w workspaces/lambda-web-functions-express
```

`test-api.sh` is the post-deploy check (not wired to npm). In the concurrency check, 429s are reported as a warning (expected on a cold endpoint) and only other errors fail.

## ⚙️ Customization

### Tune scaling per environment

`parameters/<env>-params.ts` → `webFunction`:

```typescript
webFunction: {
  maxConcurrencyPerEnvironment: 64,  // revision setting → new revision
  timeoutSeconds: 30,                // revision setting → new revision
  maxEnvironments: 3,                // endpoint setting → in-place update
  rateLimit: 100,                    // endpoint setting → in-place update (0 = kill switch)
  enableDebugRoutes: true,
},
```

### Canary a new revision

CloudFormation in this reference shifts 100% to the new revision. For a canary, set two `revisionWeights` on the endpoint (e.g. 90/10) and move to 100% after checking metrics. `lambda-web-logstream` response headers include `[rev-xxxxx]`, which makes the split observable.

### Reach private resources (RDS, ElastiCache) through a VPC

Set `vpcEgress: { enabled: true, maxAzs: 2 }` in `parameters/<env>-params.ts`. [`WebFunctionVpcEgress`](lib/constructs/web-function-vpc-egress.ts) creates an isolated VPC with a DynamoDB gateway endpoint and the network connector; the revision then has no internet access. Add interface endpoints or a NAT gateway for other services, put RDS/ElastiCache in the same VPC, and allow the connector security group. The endpoint must remain `HomeRegion`.

### WAF per-IP rate limit

`wafRateLimitPerIp` (requests per IP per 60 s). Dev uses 100,000 so the benchmark above can run from one allow-listed IP — at 10,000 the load test was blocked with 403 after ~25 s. Use a value that fits real clients (the test parameters use 1,000).

### Multi-Region

A `MultiRegion` endpoint serves one hostname from several Regions (latency routing). Keep state outside the environment and use a `sigv4a` OAC for the global hostname. Not compatible with a network connector.

## 🔧 Troubleshooting

### `CreateWebFunctionRevision`: "The specified S3 object does not exist"

The key or `versionId` does not match an object. With `BucketDeployment`, `objectKeys` omit `destinationKeyPrefix`. Also check that the bucket policy grants `lambda.amazonaws.com` with `aws:SourceArn` ending in `/*`.

### 404 from CloudFront for every path

The viewer `Host` header is forwarded. Use `AllViewerExceptHostHeader` (or a policy without `Host`).

### Many 429 with `Platform.EndpointMaxEnvThrottle` on a burst

`maxEnvironments` is reached while the dynamic per-environment limit is still low. Raise or clear `maxEnvironments`, warm up gradually, or retry with backoff. `Platform.EndpointRequestThrottle` means `rateLimit`.

### 503 without `lambda-web-error-type`

Load shedding by the service during a sharp burst. Retry with exponential backoff and jitter. `Platform.EndpointDisabled` means `rateLimit` is 0.

### `aws lambda-web ...`: "Found invalid choice"

The installed AWS CLI predates the GA API. Update the CLI, or use boto3 ≥ 1.43 (camelCase parameters).

### `cdk synth` shows `F3006 Unknown resource type 'AWS::Lambda::WebFunction'`

The bundled cfn-lint schema predates the type; CloudFormation accepts it. This workspace acknowledges the rule in the construct.

### `/aws/lambda/web/<name>.local` remains after `cdk destroy`

The service creates the `.local` group on first use (no retention). This workspace declares it in the stack; for an existing deployment, delete it once with `aws logs delete-log-group` before adding it to the stack, or the create fails with "already exists".

### A long SSE stream ends early with HTTP 200

`timeoutSeconds` cuts the request and the response still ends cleanly. Raise `timeoutSeconds` and CloudFront's origin `readTimeout`, or send an explicit end event the client can check for.

### Load test returns 403 from CloudFront

The WAF per-IP rate-based rule (`wafRateLimitPerIp`) blocked the client. It recovers once the 60 s window drops below the limit.

### An Event Function comparison returns 500 under load

API Gateway returns 500 when Lambda throttles. New accounts can have an Event Functions concurrency limit of 10 (`aws lambda get-account-settings`); Web Functions use separate quotas.

### Logs are not under `/aws/lambda/<name>`

Web Functions log to `/aws/lambda/web/<name>` (plus `<name>.local`). `aws lambda list-functions` does not list Web Functions either.

## 🧹 Clean-up

```bash
npm run stage:destroy:all -w workspaces/lambda-web-functions-express
```

In `dev` the table, code bucket (auto-delete) and both log groups are removed. Delete revisions created outside CloudFormation (e.g. a manual canary) first.

Execution environments can outlive the deleted function for a few minutes. In one of three verified teardowns, a late `platform.invokeSummary` record was replicated ~3 minutes after the stack was gone and **recreated `/aws/lambda/web/<name>` with no retention**. Check again after ~10 minutes and delete it if present:

```bash
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/web/<project>-<env>-lwf-todos
aws logs delete-log-group --log-group-name /aws/lambda/web/<project>-<env>-lwf-todos
```

## 📚 References

### AWS Documentation
- [AWS Lambda Web Functions — Developer Guide](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html)
- [Scaling behavior for Lambda Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-scaling.html)
- [Lambda Web Function endpoint access control](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-endpoint-access-control.html)
- [Restrict access to an AWS Lambda Web Function origin (CloudFront)](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda-web.html)
- [AWS::Lambda::WebFunction](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-webfunction.md) / [WebFunctionRevision](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-webfunctionrevision.md) / [WebFunctionEndpoint](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-webfunctionendpoint.md)
- [What's New: AWS Lambda announces Lambda Web Functions](https://aws.amazon.com/about-aws/whats-new/2026/10/aws-lambda-web-functions/)

### Related Architectures
- [apigw-lambda-web-adapter](../apigw-lambda-web-adapter/) — the same Express app on Event Functions behind API Gateway
- [apigw-lambdalith](../apigw-lambdalith/) / [apigw-single-purpose-lambda](../apigw-single-purpose-lambda/) — the other two integration styles
- [lambda-microvms-codex-appserver](../lambda-microvms-codex-appserver/) — the third Lambda form factor (MicroVMs)
- [cloudfront-vpc-origin](../cloudfront-vpc-origin/) — CloudFront + WAF patterns used here

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](../../LICENSE) file for details.

## 👥 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](../../CONTRIBUTING.md) for details.

## 🏆 About This Reference Architecture

**Target Level**: 300 (Intermediate)

---

**Note**: This is a reference implementation. Review and customize (authentication, secrets, KMS, scaling caps, custom domain) before deploying to production.
