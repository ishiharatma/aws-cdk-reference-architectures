# AWS Lambda Web Functions — Verified Behavior, IaC Gotchas, and Measurements

Announced 2026-10-12. Available at launch in us-east-1, us-east-2, us-west-2,
**ap-northeast-1** and eu-west-1. Classic Lambda functions were renamed "Lambda Event
Functions" (naming only).

Deploy-verified in [`lambda-web-functions-express`](../../infrastructure/workspaces/lambda-web-functions-express/)
on 2026-10-15 (ap-northeast-1, CloudFront + OAC in front, Express.js app, DynamoDB).
Numbers below are single runs from one client — orders of magnitude, not benchmarks.

Sources:
[What's New](https://aws.amazon.com/about-aws/whats-new/2026/10/aws-lambda-web-functions/) /
[Developer Guide](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html) /
[Scaling behavior](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-scaling.html) /
[Endpoint access control](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-endpoint-access-control.html) /
[CloudFront OAC for Web Function origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda-web.html)

## Model in one paragraph

A Node.js HTTP server (`nodejs24.x`, arm64, zip only, no layers) calls `listen()` on the
host:port in `AWS_LAMBDA_HTTP_ENDPOINT` (observed value: `0.0.0.0:3000`). One execution
environment (2 vCPU / 2 GB) serves many requests at once, up to a Lambda-managed dynamic
limit bounded by `maxConcurrencyPerEnvironment` (1–128, default 64). Three resources:
**Web Function** (name only, unique across all Regions of the account), **revision**
(immutable code + config), **endpoint** (mutable: auth type, up to 2 revision weights,
`maxEnvironments`, `rateLimit`). Billing: requests + active vCPU-seconds + consumed memory
GB-seconds over the environment lifetime + data transfer.

## IaC (CloudFormation / CDK)

- Types: `AWS::Lambda::WebFunction`, `AWS::Lambda::WebFunctionRevision`,
  `AWS::Lambda::WebFunctionEndpoint`. aws-cdk-lib **2.273.0** generates
  `CfnWebFunction` / `CfnWebFunctionRevision` / `CfnWebFunctionEndpoint` (no L2).
  Resource policy: `AWS::Lambda::ResourcePolicy` (`CfnResourcePolicy`) accepts a
  web-function ARN.
- Pass the **bare function name** to revision and endpoint (an ARN later breaks reading
  the endpoint `DomainName`, per the official skill). A name creates no reference, so add
  `addResourceDependency(fn)` to both.
- **`BucketDeployment.objectKeys` are relative to `destinationKeyPrefix`.** Passing
  `Fn.select(0, deployment.objectKeys)` straight into `S3Object.Key` failed the revision
  with `The specified S3 object does not exist: s3://<bucket>/<hash>.zip (versionId=...)`
  — the object was under `code/<hash>.zip`. Fix: `Fn.join('', ['code/', Fn.select(...)])`.
  `objectVersionIds` (with `extract: false`, versioned bucket) is the right source for
  `S3Object.VersionId`; a content-hashed key gives one new revision per code change.
- The cfn-lint schema bundled with aws-cdk-lib 2.273.0 reports
  `F3006 Unknown resource type 'AWS::Lambda::WebFunction'` during synth (validation
  report / jest warnings). CloudFormation accepts the type. Silence it with
  `Validations.of(scope).acknowledge({ id: 'CloudFormation-Validate::F3006', reason })` —
  `Annotations.acknowledgeWarning` does **not** suppress it.
- A code update via CloudFormation: revision replaced (~5 s) → endpoint weights updated
  (~4 s) → old revision deleted in cleanup. A probe at 5 req/s saw **790/790 HTTP 200**;
  traffic shifted gradually over ~4 s (visible in the `lambda-web-logstream` header).
- CloudFormation-created endpoints report `autoDeploymentMode: Disabled`.

## VPC egress (NetworkConnector) — verified via CloudFormation

- The live CloudFormation schema of `AWS::Lambda::WebFunctionRevision` has
  `ServiceConfig.EgressNetworkConnectorArn` (`aws cloudformation describe-type`), but the
  `CfnWebFunctionRevision.ServiceConfigProperty` generated in aws-cdk-lib 2.273.0 does **not**
  (TS2353 "egressNetworkConnectorArn does not exist"). Set it with
  `revision.addPropertyOverride('ServiceConfig.EgressNetworkConnectorArn', connector.attrLatestVersionArn)`.
  CloudFormation accepted it; the revision came up bound to `...:network-connector:<id>:1`.
  The gap is in the CDK L1, not in CloudFormation.
- With `@aws-cdk/core:validateAgainstDefaultRules`, the bundled cfn-lint fails synth with
  `E9004 'LatestVersionArn' is not one of ['Arn', 'State']` and warns
  `W3030 'WebFunction' is not one of ['MicroVm']` (AssociatedComputeResourceTypes). Both are
  outdated schema; acknowledge them with `Validations.of(resource).acknowledge(...)`.
- `VPC_EGRESS` needs an operator role (`AWSLambdaVPCAccessExecutionRole`). Create time:
  4 min 14 s. First deploy with VPC egress: 458 s.
- Isolated subnets (no NAT) + DynamoDB gateway endpoint: CRUD worked; an outbound `fetch` to
  the internet timed out (3 s). Removing the connector again (redeploy, revision replaced)
  took 61 s with 590/590 probe requests OK, and internet access returned.

## Access control behind CloudFront

- `ApplicationManaged` stays public at its own domain even behind CloudFront, and the
  resource policy is not evaluated for it. Use `IamAuth` + CloudFront OAC:
  `originAccessControlOriginType: lambda`, `signingBehavior: always-amz-auth` (the only
  value Web Function origins accept; it preserves the viewer `Authorization` header),
  `signingProtocol: sigv4` (regional) or `sigv4a` (MultiRegion/global hostname).
- `always-amz-auth` alone does not get `Authorization` to the app: for GET/HEAD, CloudFront
  removes the header unless the cache policy includes it (per the CloudFront developer guide),
  so `CachingDisabled` + `AllViewerExceptHostHeader` drops it. Use a cache policy that adds
  `Authorization` to the cache key when the app authenticates with it.
- Origin request policy must not forward the viewer `Host` (use
  `AllViewerExceptHostHeader`), otherwise the endpoint returns 404.
- Resource policy: principal `cloudfront.amazonaws.com`, action
  `lambda:InvokeWebFunctionEndpoint`, resource = endpoint ARN, condition
  `aws:SourceArn` = distribution ARN.
- Verified: unsigned request to the endpoint domain → **403** HTML
  ("You are not authorized to access this endpoint"); through CloudFront → 200.
- Code bucket policy for the service: principal `lambda.amazonaws.com`,
  `s3:GetObject` + `s3:GetObjectVersion`, `aws:SourceArn` =
  `arn:aws:lambda:<region>:<account>:web-function/<name>/*` (must end in `/*`).

## Scaling and throttling (measured)

Distinguish throttles by the `lambda-web-error-type` response header.

| Scenario | Observed |
|---|---|
| 100 parallel 2 s I/O waits, `maxEnvironments` 3, cold | 6–8 accepted; rest **429 `Platform.EndpointMaxEnvThrottle`**. New environments had a dynamic limit of ~2–3 in-flight requests despite `maxConcurrencyPerEnvironment` 64 |
| Same bursts repeated | dynamic limit ramped: 30/30 from the 4th burst (14 in flight per env), **100/100 from the 5th burst on still 3 environments (37 in flight per env)** |
| `maxEnvironments` cleared (`scalingConfig: {}`), 300 parallel | 5–6 envs, up to 49 in flight per env; **429 `Platform.EndpointRequestThrottle`** (rateLimit 100) plus **503 with no `lambda-web-error-type`** (documented load shedding) |
| 10 parallel 500 ms CPU busy loops | spread over 8 environments, latency ~0.62 s (router avoids CPU-busy envs) |
| `rateLimit: 0` | 503 `Platform.EndpointDisabled` within ~3 s; restore ~2 s |
| Idle | 9 → 3 envs within ~1 min after load; last env got `SIGTERM` ~6 min after the last request (scale to zero) |
| First request after ~22 min idle | 0.89 s end-to-end via CloudFront (init 430 ms); next request 0.086 s |
| Starting limit varies | right after a CFN revision switch on a warm endpoint, 30 parallel ran on 1 env (30 in flight); on a freshly created endpoint 30 parallel gave 8 OK / 22 × 429 twice in a row |

Account quotas from `GetWebAccountSettings` in the verification account: `maxTotalArmVCpus` 200,
`maxTotalRateLimit` 10,000, `maxRevisionsPerFunction` 50, `maxEndpointsPerFunction` 10 — lower
than the documented 2,000 vCPU / 100,000 RPS. The vCPU quota is shared by every Web Function in
the account and Region; check it before load tests.

Take-away: `maxEnvironments × maxConcurrencyPerEnvironment` is a ceiling, not the capacity
a cold burst gets. Small `maxEnvironments` + bursty clients = 429s; retry 429/503 with
backoff or leave `maxEnvironments` generous.

### Cold dynamic limit and client retries (2026-10-29, 3 trials per mode)

Each trial used a **brand-new** Web Function (bursts of 100 parallel 2 s waits, `maxEnvironments` 3,
`rateLimit` 100, signed requests straight to the `IamAuth` endpoint). A new function is needed for
every cold trial: per the scaling docs, Lambda keeps what it learned after the endpoint scales to
zero — verified: after 10 min with no `EndpointActiveEnvironments` datapoints, a burst got 30/100
(10 in flight per env), not the starting 6/100. Scripts and raw data:
[`scripts/measure/`](../../infrastructure/workspaces/lambda-web-functions-express/scripts/measure/).

| Seconds since the function became active | ~0 | ~11 | ~16 | ~21 | ~31 | ~40 |
|---|---|---|---|---|---|---|
| No retry: HTTP 200 per 100 (in flight per env) | 6 (2) | 6 (2) | 24 (8–10) | 24 (8–10) | 60 (20–21) | not run |
| Retry: HTTP 200 per 100 (in flight per env) | 16–17 (2) | 50–56 (8) | — | 90–95 (20) | 95–99 (30–31) | 100 (33–36) |

- The starting limit was **2 in flight per environment** in all 7 new functions; it rose in steps
  (2 → 8–10 → 20 → 30–36). Runs with sustained load (retries) reached the next step sooner
  (20 at ~21 s vs 8–10 without retries), so learning tracks load, not only wall time.
- Retries (full jitter, base 0.2 s, cap 5 s, max 6 attempts) raised the 8-burst total from
  200–218/800 to 657–661/800, at the cost of p99 2.0 s → 7.7 s in the first bursts and **5.7×
  attempts in the first burst** (570 for 100 requests). The extra attempts hit `rateLimit` 100:
  20–41 final 429s were `Platform.EndpointRequestThrottle`, and 503 load shedding (no
  `lambda-web-error-type`) appeared only in retry runs. Size `rateLimit` for retry traffic too.
- `CreateWebFunction` with `revisionConfig` + `endpointConfig` gives an Active endpoint in ~10 s.

### Environments kept under steady traffic (CloudFront → `/todos`, 6 min each)

| Rate | `EndpointActiveEnvironments` | `EnvironmentMaxMemoryUsage` | Errors / p99 |
|---|---|---|---|
| 2 req/s | 1 | 183–206 MB | 0 / 61 ms |
| 20 req/s | 1, then 2 after ~4 min | up to 431 MB | 0 / 57 ms |

A two-point fit of `EnvironmentCPUTime` gives ~2.0 ms CPU per request plus ~7.4 ms CPU per
environment-second of idle time (billed as vCPU-seconds). `EnvironmentCPUTime` and
`EnvironmentActiveTime` are reported in **milliseconds** (120,000 per 2-minute point = 1
environment).

## Head-to-head with API Gateway + Event Function (Lambda Web Adapter)

Same account, same client in Japan, closed-loop load, 30 s after 10 s warm-up, `/todos` scanning
20 DynamoDB items. Web Function via CloudFront (OAC), LWA via API Gateway REST directly.

| Concurrency | Web Functions | API Gateway + Event Function (256 MB arm64) |
|---|---|---|
| 2 | p50 33.9 ms / p99 50.8 ms | p50 47.9 ms / p99 144.4 ms |
| 8 | 233 rps, all 200, 4 environments | 92 rps OK + 3,484 × 500 |

- The 500s were Lambda throttles surfaced by API Gateway: the account's **Event Functions limit
  was 10 concurrent executions** (`aws lambda get-account-settings`; Throttles 85,038), which also
  caps synchronous invokes at ~100/s. **Web Functions do not count against it** (separate vCPU /
  RPS quotas) — a new account can serve far more HTTP traffic on Web Functions than on Event
  Functions before any quota increase.
- Compute per request: 2.5 ms CPU (Web Function) vs 15.6 ms billed duration (Event Function).
  Per 1M requests ≈ $0.45 (Web Function incl. memory of idle environments) vs $0.25 (Event
  Function) + $4.25 (API Gateway REST). The saving is API Gateway, not compute.
- Estimate with the steady-load inputs (`scripts/measure/cost_model.py`, list prices 2026-10-29):
  against **REST** API the saving is large, but against **HTTP API ($1.29/M)** or **CloudFront +
  Function URL** it mostly disappears — CloudFront's own $1.20/M HTTPS request fee is about what
  API Gateway HTTP API costs. For a 15.6 ms CRUD request, Web Functions + CloudFront never gets
  cheaper than CloudFront + Function URL + Event Function; the crossover appears only as
  requests wait longer (~2.7M req/month at 500 ms, ~0.6M at 2 s), because waiting is billed as
  GB-seconds on Event Functions but not as vCPU-seconds on Web Functions.

## Observability

- **Log delivery delay** (`ingestionTime − timestamp`): `.local` 2.8–9.0 s, main group
  7.1–15.4 s. Querying right after a request can return nothing.
- **Deleting a Web Function does not stop its environments at once, and their last log lines
  recreate the log groups.** First seen once in three `cdk destroy` runs (`platform.invokeSummary`
  ~2.5 min later recreated `/aws/lambda/web/<name>` ~3 min after `DELETE_COMPLETE`). On
  2026-10-29, deleting 8 functions via the API right after load recreated `/aws/lambda/web/<name>`
  and/or `<name>.local` (no retention) for **7 of 8 functions**, within about a minute. Sweep the
  log groups again a few minutes after deleting, or own them in the stack.
- **`SIGTERM` handling**: with `server.close()` in a `SIGTERM` handler, `platform.spinDownReport`
  was `success` in 25–60 ms (`platform.spinDownStart` → report).
- **SSE beyond `timeoutSeconds`** (40 events at 1 s, timeout 30 s, through CloudFront): 30
  events, **HTTP 200, clean end of stream, curl exit 0** — truncation is invisible to the client.
  Fix: end every stream with an explicit terminal event (`event: done`) and treat its absence as
  truncation — verified on 2026-10-29: 4/4 truncated streams detected at 30.1 s and 4/4 complete
  streams (~5.1 s) recognized
  ([`sse-check.mjs`](../../infrastructure/workspaces/lambda-web-functions-express/scripts/measure/sse-check.mjs)).

- **The `<log-group>.local` group outlives the stack.** The service creates it on first use
  with no retention, so after `cdk destroy` it remained (never-expire). Declare it in the
  stack (`/aws/lambda/web/<name>.local`, same retention/removal policy) and make the revision
  depend on it — verified: the service then writes to the stack-owned group and `destroy`
  leaves nothing behind. If it already exists from an earlier deploy, delete it first or the
  `AWS::Logs::LogGroup` create fails with "already exists".

- Logs: `/aws/lambda/web/<name>` plus an auto-created `<name>.local` group. Every
  `console.*` line becomes JSON with `timestamp`, `level`, `requestId`, `endpointName`,
  `region`. Extra objects passed to `console.log('msg', obj)` are **not** merged as JSON
  fields — they are `util.inspect`-formatted into the `message` string;
  `console.log(JSON.stringify(obj))` lands as an escaped JSON string inside `message`.
- `platform.initReport` (`initializationType: native-http`) carries init metrics; for a
  2.5 MB esbuild bundle (Express + AWS SDK): 445–520 ms total, 335 ms CPU, ~170 MB.
- Work scheduled after the response (`setTimeout` after `res.json`) ran, and its log line
  still carried the original request's `requestId`.
- Response headers: `lambda-web-request-id`, `lambda-web-logstream`
  (`YYYY/MM/DD/<name>[rev-xxxxx]<env-id>` — identifies the serving revision).
- Metrics namespace `AWS/Lambda/Web` (`EnvironmentCPUTime`, `EnvironmentActiveTime`,
  `EnvironmentConcurrentRequests`, `EnvironmentMaxMemoryUsage`, `ExecutedRequests`,
  `HTTPResponseStatusClass4XX`, `ResponseBytes`) and `AWS/Lambda/Web/Usage`
  (`EndpointActiveEnvironments`, `EndpointActiveEnvironmentThrottles`, `ExecutedRequests`,
  dimension `ExecutionRegion`). For an I/O-dominated 5-minute window:
  `EnvironmentCPUTime` 4.6 s vs `EnvironmentActiveTime` 361.7 s (≈1.3%).
- `aws lambda list-functions` does not list Web Functions.

## Tooling

- AWS CLI **2.37.12** ships a pre-GA `lambda-web` model: only `get-web-account-settings`,
  help text says "experimental and for internal AWS use only". `invalid choice` for
  `get-web-function-endpoint` etc. means the CLI is too old, not that the feature is missing.
- boto3 **1.43.114** has the full client. Its parameters are **camelCase**
  (`functionName`, `endpointName`, `revisionWeights`), unlike other boto3 services.
- `get-web-function-revision` returns environment variables in plaintext — keep secrets
  out of them.
- Revision create → Active: ~5.5 s. Endpoint weight change (90/10) applied in ~2.9 s;
  rollback to 100% in ~3.5 s. A 90/10 split measured 9.4% on the canary (22/233).

## Pricing (ap-northeast-1, AWS Price List API, 2026-10, arm64)

| Usage type | Price |
|---|---|
| `APN1-Lambda-Web-Request-ARM` | $0.0000003 per request |
| `APN1-Lambda-Web-vCPU-Second-ARM` | $0.0000322421 per vCPU-second |
| `APN1-Lambda-Web-Memory-GB-Second-ARM` | $0.0000042688 per GB-second |

Query: `aws pricing get-products --region us-east-1 --service-code AWSLambda --filters Type=TERM_MATCH,Field=regionCode,Value=ap-northeast-1` and grep usage types for `Web`
(the pricing web page renders the Web Functions table dynamically, so scraping it misses
the numbers).
