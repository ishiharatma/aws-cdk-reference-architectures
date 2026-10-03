# Serverless Codex App Server on AWS Lambda MicroVMs — A VM-Isolated, Per-Session Data Plane behind a Cognito-Authenticated Control Plane

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

## Introduction

This reference implementation runs an on-demand, VM-isolated [`codex app-server`](https://github.com/openai/codex) per session on [AWS Lambda MicroVMs](https://aws.amazon.com/lambda/lambda-microvms/). A session control plane (an API Gateway HTTP API with 7 Lambda functions plus a WebSocket API with 3 more) brokers each session's MicroVM lifecycle, and the turn output is delivered by both push (WebSocket) and pull (polling) from a DynamoDB event table.

This architecture demonstrates:

- A per-session, VM-isolated data plane with suspend/resume and idle auto-suspend, instead of a long-running shared host
- An in-VM HTTP server that stands in for the missing "log in, execute, and stream the output" primitive, so external callers only need plain HTTPS
- `EventsTable` as the single source of truth for output, with WebSocket push through DynamoDB Streams layered on top and polling as the fallback
- Cognito-authenticated, owner-scoped access on every HTTP route and on the WebSocket `$connect` route
- The OpenAI API key held in Secrets Manager and never baked into the image or the Infrastructure-as-Code
- Deploy-verified end to end on 2026-09-27; see [Deploy verification](#-deploy-verification) for the six defects the real deployment found and fixed

## 📑 Table of Contents

- [Architecture Overview](#️-architecture-overview)
- [Design Decisions & Best Practices](#-design-decisions--best-practices)
- [Cost Optimization](#-cost-optimization)
- [Security Considerations](#-security-considerations)
- [Prerequisites](#-prerequisites)
- [Deployment Guide](#-deployment-guide)
- [Usage](#usage)
- [Testing Strategy](#-testing-strategy)
- [Customization](#️-customization)
- [Deploy verification](#-deploy-verification)
- [Troubleshooting](#-troubleshooting)
- [Clean-up](#-clean-up)
- [References](#-references)

## 🏗️ Architecture Overview

![Architecture Overview](overview.drawio.svg)

A session **control plane** (an HTTP API with 7 Lambda functions, plus a WebSocket API with 3 more) brokers
the lifecycle of on-demand **data plane** sessions: each session is a VM-isolated
[AWS Lambda MicroVM](https://aws.amazon.com/lambda/lambda-microvms/) running
[`codex app-server`](https://github.com/openai/codex) (OpenAI Codex CLI's JSON-RPC agent protocol --
Thread/Turn/Item). As of this reference's authoring, Lambda MicroVMs has no built-in way to log into a running
MicroVM, execute a command, and stream the response back to a caller. So every MicroVM runs **its own HTTP
server** (`src/microvm-image/server/`) that plays that role: it answers the platform's lifecycle hook calls, it
relays JSON-RPC requests from clients to the `codex app-server` child process it manages, and an in-VM **Event
Handler** persists every line `codex app-server` emits to a DynamoDB **EventsTable** -- so a session's Thread
content stays readable even after its MicroVM is SUSPENDED or terminated. `EventsTable` writes also fan out to
any client connected over the **WebSocket API** in near-real-time via **DynamoDB Streams**, so output does not
have to be polled to be timely. The control plane itself never proxies app-server *input* traffic; it only
brokers session lifecycle and output delivery.

```
Client (Web UI / IDE / CLI)                                            ── control plane (HTTP) ──
   │  1. POST /sessions (Cognito JWT)
   ▼
API Gateway HTTP API ── JWT Authorizer (Cognito User Pool)
   │
   ▼
Control-plane Lambdas: create / get / delete / suspend / resume / get-events
   │  RunMicrovm / GetMicrovm / SuspendMicrovm / ResumeMicrovm /
   │  TerminateMicrovm / CreateMicrovmAuthToken                        ── data plane ──
   ▼
Lambda MicroVMs data plane
   │  launches a Firecracker microVM from the codex app-server image;
   │  POST /run (RunMicrovmRequest.runHookPayload = {sessionId}) primes it
   ▼
MicroVM (VM-isolated, dedicated HTTPS endpoint)
   in-VM HTTP server (server/index.mjs)
     ├─ lifecycle hooks: GET /ready · POST /run,/suspend,/resume,/terminate
     ├─ /rpc  ──stdio JSON-RPC──▶  codex app-server (child process)
     └─ Event Handler  ──────────▶  DynamoDB EventsTable (every output line)
   ── egress via AWS::Lambda::NetworkConnector → NAT Gateway → OpenAI API

   │  2. POST {endpoint}/rpc + X-aws-proxy-auth, direct to the MicroVM endpoint
   ▼
Client
   │  3a. WS connect wss://.../{stage}?sessionId=...&token=...          ── control plane (WebSocket) ──
   ▼                                                    ┌── DynamoDB Streams (NEW_IMAGE) ──┐
API Gateway WebSocket API                               │                                   ▼
   │ $connect (Lambda authorizer verifies Cognito ID token)     EventsTable ──────▶ forward-event Lambda
   ▼                                                                                        │
ws-connect Lambda ──▶ ConnectionsTable (sessionId → connectionId)  ◀───────────────────────┘
                                                                     PostToConnection (push new events)
   │  3b. GET /sessions/{id}/events?after=N  (fetch anything written before/around the WS connect)
   ▼                                                                    ── control plane (HTTP) ──
API Gateway → get-events Lambda ──▶ DynamoDB EventsTable (read-only; MicroVM state-independent)
```

### Key Components

| Component | Purpose |
|---|---|
| `AWS::Lambda::MicrovmImage` (`CfnMicrovmImage`) | Packages `src/microvm-image/` (Node.js + `@openai/codex` + the in-VM HTTP server) into a snapshotted MicroVM image. |
| `AWS::Lambda::NetworkConnector` + VPC (1 NAT Gateway) | The only way a MicroVM's `egressNetworkConnectors` can reach the internet (the OpenAI API); without it, `codex app-server` has no outbound network access at all. |
| **In-VM HTTP server** (`server/index.mjs`) | Answers the platform's lifecycle hooks over HTTP (`GET /ready`, `POST /run`/`/suspend`/`/resume`/`/terminate`) and relays `POST /rpc` requests to the `codex app-server` child process it spawns and manages (`server/codex-process.mjs`). |
| **Event Handler** (`server/event-handler.mjs`) | Subscribes to every line `codex app-server` writes to stdout and persists it to `EventsTable`, sequenced per session. |
| Secrets Manager secret | Holds the OpenAI API key. Only its ARN is baked into the image (`OPENAI_API_KEY_SECRET_ARN`); the in-VM server resolves the value at container-start time via the execution role (`server/secret.mjs`). |
| 7 HTTP control-plane Lambdas | `create-session` (RunMicrovm + CreateMicrovmAuthToken), `get-session` (GetMicrovm), `delete-session` (TerminateMicrovm), `suspend-session` (SuspendMicrovm), `resume-session` (ResumeMicrovm + a fresh auth token), `get-events` (polls `EventsTable`). |
| 3 WebSocket Lambdas | `ws-authorizer` (verifies the Cognito ID token on `$connect`), `ws-connect` (registers the connection against a session), `ws-disconnect` (deregisters it), `forward-event` (DynamoDB Streams-triggered; pushes new `EventsTable` items to connected clients). |
| DynamoDB `SessionsTable` | One item per session (`sessionId`, `ownerId`, `microvmId`, `endpoint`, `state`), TTL-expired automatically. |
| DynamoDB `EventsTable` | One item per `codex app-server` output line (`sessionId`, `sequence`, `event`), written by the in-VM Event Handler. Streams (`NEW_IMAGE`) trigger `forward-event`; read directly by `get-events`. Survives the MicroVM's own lifecycle. |
| DynamoDB `ConnectionsTable` | Which WebSocket connections are watching which session (`sessionId`, `connectionId`, `ownerId`), with a `ByConnectionId` GSI so `ws-disconnect` can look up a connection's session. |
| Cognito User Pool | Backs both the HTTP API's JWT authorizer and the WebSocket API's Lambda authorizer; `ownerId`/`sub` scopes every session, event, and connection record to its creator. |

### Thread creation, Turn execution, and output delivery

The sequence, including the push path:

1. **Start a session** -- `POST /sessions` (control plane) launches a MicroVM from the pre-baked image
   (`RunMicrovm`), with `runHookPayload: {"sessionId": "..."}` delivered as the body of the image's `/run`
   hook so the in-VM Event Handler knows which `EventsTable` partition to write to. The response carries the
   MicroVM's own `endpoint` and a short-lived `X-aws-proxy-auth` token.
2. **Drive a Turn** -- the client `POST`s a JSON-RPC 2.0 request straight to `{endpoint}/rpc` (with the auth
   header). The in-VM server relays it to `codex app-server`'s stdin and, for requests carrying an `id`,
   returns the matching stdout response synchronously; every line -- responses and server-initiated
   notifications alike -- is also captured by the Event Handler.
3. **Receive output** -- rather than reading the MicroVM directly:
   - **Push (near-real-time):** the client opens a WebSocket connection
     (`wss://.../{stage}?sessionId=...&token=<Cognito ID token>`). `ws-authorizer` verifies the token,
     `ws-connect` registers the connection in `ConnectionsTable`, and from then on every `EventsTable` write
     for that session is pushed to it by `forward-event` (via DynamoDB Streams + `PostToConnection`) the
     moment it's written.
   - **Pull (catch-up and fallback):** `GET /sessions/{sessionId}/events?after={sequence}` (control plane)
     reads `EventsTable` directly. A client should call this once right after connecting the WebSocket (to
     pick up anything written just before the connection registered) and can fall back to polling it entirely
     if it doesn't want to hold a WebSocket connection open. Either path works whether the MicroVM is
     RUNNING, SUSPENDED, or already terminated, because both only ever read `EventsTable`.

### MicroVM lifecycle hooks

`cdk synth`'s CloudFormation Validate plugin confirms that `Hooks.MicrovmHooks.*` and
`Hooks.MicrovmImageHooks.*` on `AWS::Lambda::MicrovmImage` are `ENABLED`/`DISABLED` switches, not literal
script paths. Enabling a hook makes the platform call it as an **HTTP request against
the container's `Hooks.port`**:

| Hook | HTTP call | When | What the in-VM server does |
|---|---|---|---|
| `ready` (image build) | `GET /ready` | Polled after the Dockerfile's container starts, before the Firecracker snapshot is taken | Returns 200 once `codex app-server` has been spawned and the Event Handler is wired up. |
| `validate` (image build) | `GET /validate` | Polled once after the snapshot is taken | Same check as `ready` -- confirms the snapshot itself resumes into a working state. |
| `run` | `POST /run` | MicroVM PENDING → RUNNING | Reads `runHookPayload`'s `sessionId` and binds the Event Handler to it. `codex app-server` and the HTTP server are already running (resumed from the snapshot), so this step is lightweight. |
| `suspend` / `resume` | `POST /suspend` / `POST /resume` | RUNNING ⇄ SUSPENDED | Log checkpoints only -- Firecracker's own memory+disk snapshot preserves the `codex app-server` process (and any in-flight Thread/Turn/Item state) automatically. |
| `terminate` | `POST /terminate` | Before the MicroVM is torn down | Best-effort graceful shutdown of `codex app-server`. |

## 🎯 Design Decisions & Best Practices

### 1. An in-VM HTTP server stands in for a missing "exec and stream" primitive

Lambda MicroVMs has no API to log into a running MicroVM and stream a command's output back. So this reference has the image itself run an HTTP server that relays JSON-RPC to
`codex app-server` and captures its output, so external callers only ever need plain HTTPS.

### 2. Output delivery is push (WebSocket) with pull (polling) as the source of truth

Polling alone is the simplest delivery mechanism. This reference keeps `EventsTable`
as the single source of truth (so a client can always poll `get-events` and get the right answer) but adds a
push path on top: a DynamoDB Streams trigger (`forward-event`) delivers each new item to connected WebSocket
clients as it's written. This is additive, not a replacement -- a client that never opens a WebSocket
connection still works purely by polling, and a client that does should still poll once after connecting to
cover the gap between session start and WebSocket registration.

### 3. WebSocket connection state is decoupled from the MicroVM's lifecycle

`ConnectionsTable` tracks *client* connections, entirely separate from the MicroVM's own RUNNING/SUSPENDED
state. A client's WebSocket session can stay open across a MicroVM being suspended and resumed (output simply
pauses until the next event is written); conversely, closing the WebSocket never affects the MicroVM.

### 4. A Cognito ID token cannot ride a WebSocket handshake's Authorization header

Browsers do not let application code set custom headers on a WebSocket handshake, so the ID token travels as
a `token` query string parameter instead, verified by a `WebSocketLambdaAuthorizer` (`ws-authorizer.ts`) using
[`aws-jwt-verify`](https://github.com/awslabs/aws-jwt-verify). This differs from the HTTP API's managed
`HttpUserPoolAuthorizer`, which WebSocket APIs cannot use.

### 5. The control plane never proxies app-server *input* traffic

`create-session` and `resume-session` return the MicroVM's own `endpoint` and a short-lived
`X-aws-proxy-auth` token (from `CreateMicrovmAuthToken`, scoped to a single port via `allowedPorts`). The
client sends JSON-RPC requests to that endpoint directly. This keeps the control-plane Lambdas' latency and
cost independent of Turn traffic volume; only the (much smaller) output-delivery path flows back through it.

### 6. `/rpc` is a generic relay, not a typed Thread/Turn REST API

The in-VM server's `/rpc` endpoint forwards a raw JSON-RPC 2.0 request body verbatim to `codex app-server`'s
stdin, rather than exposing fixed `/threads`/`/turns` REST routes with hardcoded method names. This reference
could not independently verify `codex app-server`'s exact method/parameter schema against the Codex CLI
source, so it deliberately stays protocol-agnostic at the HTTP boundary -- see the
[Codex CLI repository](https://github.com/openai/codex) for the actual `initialize`/thread/turn/item methods
to send.

### 7. Suspend beats terminate for cost

`idlePolicy` auto-suspends an idle MicroVM (billed only for Firecracker snapshot storage) rather than
terminating it. `POST /sessions/{id}/suspend` and `/resume` let a client that knows a session is temporarily
unneeded (a closed tab) trigger that transition immediately instead of waiting out the idle timeout.

### 8. The OpenAI API key never enters the image or Infrastructure-as-Code

`CfnMicrovmImage.environmentVariables` carries only `OPENAI_API_KEY_SECRET_ARN` (a fixed value for every
session). `server/secret.mjs` resolves the actual secret value from Secrets Manager at container-start time,
using the credentials the platform injects for the MicroVM's `executionRoleArn`.

### 9. Sessions, events, and connections are owner-scoped end to end

The Cognito subject (`sub`) becomes `ownerId` on every `SessionsTable` and `ConnectionsTable` item; HTTP
routes 404 and WebSocket `$connect` rejects a session that isn't the caller's own, rather than leaking another
user's MicroVM endpoint or output.

### 10. Well-Architected Framework Alignment

| Pillar | How this reference addresses it |
|---|---|
| Operational Excellence | CloudWatch access logs on the HTTP API stage and a dedicated CloudWatch log group per control-plane Lambda and per MicroVM image. |
| Security | VM-level isolation per session (Firecracker, no shared kernel), Cognito-backed authorization on every HTTP route and the WebSocket `$connect` route, owner-scoped session/event/connection records, least-privilege DynamoDB/Secrets Manager grants. |
| Reliability | Turn output in DynamoDB survives MicroVM SUSPEND/terminate independently, and WebSocket delivery degrades gracefully to polling if a connection drops; a single NAT Gateway is a deliberate cost/AZ-resilience tradeoff -- add a NAT Gateway per AZ for production. |
| Performance Efficiency | MicroVMs resume from a pre-initialized Firecracker snapshot (with `codex app-server` and the in-VM HTTP server already running) instead of booting cold; output reaches clients via push rather than fixed-interval polling. |
| Cost Optimization | `idlePolicy` auto-suspend, DynamoDB TTL for expired sessions/connections, PAY_PER_REQUEST billing throughout, WebSocket push avoids wasted polling requests once a Turn goes idle. |

## 💰 Cost Optimization

This reference introduces cost dimensions this repository's other patterns don't have (MicroVM run/suspend
time, a NAT Gateway, Cognito, a WebSocket API). **Do not treat any number here as a quote** -- always check the
AWS Pricing pages for Lambda MicroVMs, NAT Gateway, Cognito, API Gateway WebSocket APIs, and DynamoDB in your
Region before estimating a real workload's cost.

Rough cost *drivers*, in the order they matter for this architecture:

1. **MicroVM RUNNING time** -- billed while a session's MicroVM is actively running (the main driver for a
   busy Codex session).
2. **MicroVM SUSPENDED time** -- billed only for Firecracker snapshot storage; this is why `idlePolicy` and
   the explicit `/suspend` route matter for cost, not just latency. Because Turn output lives in
   `EventsTable`, suspending aggressively costs nothing in output availability.
3. **NAT Gateway** -- an hourly charge plus per-GB data processing for every byte `codex app-server` sends
   to/from the OpenAI API. A single NAT Gateway (this reference's default) is the cheapest viable setup;
   consider VPC endpoints for any AWS service traffic MicroVMs need beyond internet egress.
4. **Cognito** -- free tier covers a meaningful number of MAUs before per-MAU billing starts; the Plus
   feature plan (`AwsSolutions-COG8`, suppressed here) adds further per-MAU cost if enabled.
5. **WebSocket API connection-minutes + messages** -- billed per connection-minute plus per message; for a
   chatty Turn this replaces a stream of small polling requests with one open connection and one message per
   event, which is typically cheaper than aggressive polling but is a cost dimension polling alone doesn't
   have. `forward-event`'s DynamoDB Streams invocations are billed as ordinary Lambda invocations.
6. **API Gateway HTTP API + control-plane Lambdas** -- negligible relative to the above: the control plane
   only brokers session lifecycle and event-delivery calls, not Turn input traffic.
7. **DynamoDB** -- PAY_PER_REQUEST with a short TTL keeps this near-zero for typical session volumes; a
   chatty Turn writes one `EventsTable` item per `codex app-server` output line, so very high-frequency event
   streams are the one place this table's write cost (and the corresponding Streams-triggered `forward-event`
   invocations) is worth watching.

### Cost notes specific to this pattern

- Tune `controlPlane.idleTimeoutInMinutes` down for cost-sensitive environments; a shorter idle window
  suspends unused MicroVMs sooner at the cost of a resume round trip on the next request.
- `controlPlane.suspendedDurationInMinutes` bounds how long you pay for snapshot storage before the platform
  terminates an abandoned session outright -- keep it aligned with `sessionRecordTtlInDays`.
- A client that only needs occasional updates (not a live coding-agent UI) may be cheaper served by polling
  `get-events` alone and never opening a WebSocket connection at all -- the push path is there for
  responsiveness, not required for correctness.

## 🔒 Security Considerations

### Implemented

- VM-level isolation per session (Firecracker MicroVMs, no shared kernel between sessions).
- Cognito-backed authorization on every HTTP control-plane route (`HttpUserPoolAuthorizer`) and on the
  WebSocket API's `$connect` route (a `WebSocketLambdaAuthorizer` verifying the same user pool's ID tokens).
- Owner-scoped session, event, and connection records (`ownerId`/`sub` from the JWT).
- The OpenAI API key lives only in Secrets Manager; only its ARN is baked into the image.
- Least-privilege DynamoDB (`grantReadWriteData`/`grantWriteData`/`grantReadData`, each scoped to one table)
  and Secrets Manager (`grantRead`, scoped to the one secret) grants; `forward-event`'s
  `execute-api:ManageConnections` grant is scoped to the one WebSocket API stage.
- Outbound-only security group for the MicroVM egress path (no inbound rules).

### Intentionally out of scope (add per environment)

- WAFv2 Web ACL on the HTTP API (WAF does not support WebSocket APIs).
- Request body/schema validation beyond what the Lambda handlers check themselves.
- Cognito MFA and the Plus feature plan (advanced security features).
- VPC Flow Logs.
- Secrets Manager automatic rotation (not applicable to a third-party API key with no rotation Lambda; rotate
  manually).
- Authenticating the in-VM server's `/rpc` endpoint separately from the platform's own `X-aws-proxy-auth`
  gate: any caller holding a valid MicroVM auth token can reach `/rpc`, `/run`, `/suspend`, `/resume`, and
  `/terminate` alike, since they share one `Hooks.port`. Restrict this further per environment if the
  platform's own hook-invocation channel is not otherwise isolated from client traffic.

### Two items resolved by deploy verification

Both items previously listed here as unverified were confirmed correct by a real deploy on
2026-09-27 (see [Deploy verification](#-deploy-verification)):

1. **IAM trust policy.** `microvmServicePrincipal` using `lambda.amazonaws.com` is correct --
   image builds and MicroVM execution both succeeded with it.
2. **`codex app-server`'s JSON-RPC framing.** Newline-delimited JSON over stdio is correct -- a
   real `initialize` request/response round-trip succeeded through `/rpc` unchanged.

### CDK Nag

`test/compliance/cdk-nag.test.ts` runs the `AwsSolutionsChecks` pack and asserts zero unsuppressed
warnings/errors. Every suppression carries a reason tied to one of the "intentionally out of scope" items
above, plus `AwsSolutions-IAM5` for the MicroVM data-plane actions (their resource ARNs -- MicroVM and image
identifiers -- are minted at `RunMicrovm` time and cannot be scoped ahead of deployment).

## 📋 Prerequisites

- Node.js 20.x+, the AWS CDK CLI, and an AWS profile as described in the repository root README.
- **A real MicroVM base image ARN and version.** `parameters/dev-params.ts` ships placeholders.
  Discover real values with:
  ```sh
  aws lambda-microvms list-managed-microvm-images
  aws lambda-microvms list-managed-microvm-image-versions --image-identifier <arn-from-above>
  ```
  and update `parameters/dev-params.ts` before deploying. The real ARN format is
  `arn:aws:lambda:<region>:aws:microvm-image:<name>-<version>` (e.g.
  `arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1`) -- under the `lambda:` namespace
  with an `aws:` account segment, not `arn:aws:lambda-microvms:...:image/...`.
- Access to AWS Lambda MicroVMs in your target account/Region (a preview/limited-availability feature as of
  this reference's authoring -- confirm it is enabled for your account).
- An OpenAI API key to populate the `OpenAiApiKeySecret` (its ARN is a stack output) after the first deploy.

## 🚀 Deployment Guide

```sh
cd infrastructure
npm install

# 1. Edit parameters/dev-params.ts with real baseImageArn/baseImageVersion values.

# 2. Deploy
npm run deploy:all -w workspaces/lambda-microvms-codex-appserver --project=<project> --env=dev

# 3. Populate the OpenAI API key (ARN from the OpenAiApiKeySecretArn stack output)
aws secretsmanager put-secret-value \
  --secret-id <OpenAiApiKeySecretArn> \
  --secret-string 'sk-...'

# 4. Create a Cognito user to authenticate as (UserPoolId from the stack output)
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username you@example.com
aws cognito-idp admin-set-user-password --user-pool-id <UserPoolId> --username you@example.com \
  --password '<a-strong-password>' --permanent
```

## Usage

```sh
# Authenticate against the User Pool Client (UserPoolClientId from the stack output) to get an ID token,
# then start a session:
curl -X POST "$API_URL/sessions" -H "Authorization: Bearer $ID_TOKEN"
# => { "sessionId": "...", "state": "PENDING", "endpoint": "https://...", "authToken": { "X-aws-proxy-auth": "..." } }

# Open a WebSocket connection to receive output as it's written (WebSocketUrl from the stack output):
wscat -c "$WEBSOCKET_URL?sessionId=$SESSION_ID&token=$ID_TOKEN"

# Send a JSON-RPC request straight to the MicroVM's own endpoint (see the Codex CLI docs for the actual
# initialize/thread/turn method names and parameters to use):
curl -X POST "$ENDPOINT/rpc" -H "X-aws-proxy-auth: $AUTH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# Output arrives on the WebSocket connection as it's written; catch up on anything written before it
# registered (or if you'd rather not hold a WebSocket connection open at all) by polling instead:
curl "$API_URL/sessions/$SESSION_ID/events?after=0" -H "Authorization: Bearer $ID_TOKEN"

# When done:
curl -X DELETE "$API_URL/sessions/$SESSION_ID" -H "Authorization: Bearer $ID_TOKEN"
```

## 🧪 Testing Strategy

```sh
npm run test:unit -w workspaces/lambda-microvms-codex-appserver        # resource property assertions
npm run test:snapshot -w workspaces/lambda-microvms-codex-appserver    # whole-template regression safety net
npm run test:compliance -w workspaces/lambda-microvms-codex-appserver  # cdk-nag AwsSolutions pack
```

`cdk synth` itself also validates the template against the `AWS::Lambda::MicrovmImage` /
`AWS::Lambda::NetworkConnector` CloudFormation schemas (the "CloudFormation Validate" plugin); watch its
output for `W3030` warnings after changing `hooks` or `cpuConfigurations`.

## ⚙️ Customization

### Drop the WebSocket path and poll only

If a client doesn't need near-real-time updates, it can call `GET /sessions/{id}/events` alone and never open
a WebSocket connection -- `EventsTable` is the source of truth either way, so this needs no server-side
change. To remove the WebSocket infrastructure entirely, delete the `WebSocketApi`/`WebSocketStage`, the
`ws-*`/`forward-event` Lambdas, `ConnectionsTable`, and the `stream` property on `EventsTable`.

### Scope MicroVM data-plane IAM actions further

If your account exposes a stable ARN pattern for MicroVM/image resources, replace the `resources: ['*']` in
`microvmDataPlanePolicy` (`lib/stacks/lambda-microvms-codex-appserver-stack.ts`) with that pattern and drop
the corresponding `AwsSolutions-IAM5` suppression.

### Add a NAT Gateway per AZ

Change `natGateways: 1` to `natGateways: 2` in the `Vpc` construct for production-grade AZ resilience (at
roughly double the NAT Gateway cost).

## ✅ Deploy verification

Deployed to a real account (`ap-northeast-1`) on 2026-09-27, tested at the infrastructure and
JSON-RPC protocol level, then torn down. No OpenAI API key was used (kept scope to infrastructure
verification) -- the OpenAI-key-authenticated Turn itself was not exercised. Six real bugs were
found and fixed along the way, none of which any static check (`cdk synth`, unit tests, cdk-nag)
could have caught, since every one is a live-service behavior:

1. **`AWS::Lambda::NetworkConnector` needs an `operatorRole`** for `VPC_EGRESS` connectors --
   `CREATE_FAILED` with `"NetworkConnectorOperatorRole is required for VPC_EGRESS connector type"`.
   Added an IAM role (`AWSLambdaVPCAccessExecutionRole` managed policy) and passed it as
   `operatorRole`.
2. **The image build's `/ready`/`/validate` hooks run under the build role's credentials, not the
   execution role's** -- the build failed with `secretsmanager:GetSecretValue` `AccessDeniedException`
   naming the build role, even though the execution role already had that grant. Granted the build
   role the same read access.
3. **`codex app-server` refuses to start if `CODEX_HOME` doesn't exist** -- `ENV CODEX_HOME=...` in
   the Dockerfile doesn't create the directory. Added `RUN mkdir -p "$CODEX_HOME"`.
4. **Lifecycle hooks live under `/aws/lambda-microvms/runtime/v1/<hook-name>`, not bare paths** --
   confirmed against the AWS Lambda MicroVMs Developer Guide's OpenAPI spec. The server answering
   bare `/ready` got a silent 404 on every hook call, and the build just timed out with zero
   application-level error. This was the fix that took the build from failing twice to succeeding
   on the next attempt. Also fixed: the `/run` hook's body is `{ microvmId, runHookPayload }` where
   `runHookPayload` is a string requiring a second `JSON.parse`, not `{ sessionId }` directly.
5. **The IAM action prefix is `lambda:`, not `lambda-microvms:`** -- despite the dedicated SDK/CLI
   namespace, `RunMicrovm` and friends are authorized under core Lambda. Confirmed by a real
   `AccessDeniedException` naming `lambda:RunMicrovm`.
6. **`RunMicrovm` needs `lambda:PassNetworkConnector`** on the egress connector's ARN (a
   `PassRole`-shaped grant), *and* on an AWS-managed ingress connector
   (`arn:...:network-connector:aws-network-connector:HTTP_INGRESS`) that gets implicitly attached
   even when `ingressNetworkConnectors` is never set.

Full writeup with confirmation details for each: [`docs/knowledge/lambda-microvms.md`](../../../docs/knowledge/lambda-microvms.md).

What was actually confirmed, end to end, with all six fixes applied:

- `cdk deploy '**'` created the full stack (VPC/NAT, Cognito, HTTP + WebSocket APIs, 10 Lambdas,
  the MicroVM image) cleanly.
- `POST /sessions` (as a real Cognito-authenticated user) returned `201` with a real MicroVM
  endpoint and auth token; `GET /sessions/{id}` showed the MicroVM reach `RUNNING`.
- `POST {endpoint}/rpc` with `X-aws-proxy-auth` reached the in-VM server, which relayed to a real
  `codex app-server` child process over stdio -- a malformed `initialize` request got a genuine
  JSON-RPC error from codex itself (`missing field 'clientInfo'`), and a corrected one got a real
  successful handshake response (`codexHome`, `platformOs`, etc.).
- `GET /sessions/{id}/events` showed the DynamoDB Streams pipeline working: the `initialize`
  response, a real `configWarning` event from codex about a missing `bubblewrap` sandbox
  dependency, and a `remoteControl/status/changed` event, all persisted and readable back.
- `DELETE /sessions/{id}` (`TerminateMicrovm`) correctly transitioned both test MicroVMs to
  `TERMINATED`, confirmed via `aws lambda-microvms list-microvms`.
- The stack was destroyed afterward and confirmed gone.

Not covered by this pass: an actual OpenAI-backed Turn (needs a real API key), suspend/resume,
auto-resume-on-traffic, and the WebSocket push path.

## 🔧 Troubleshooting

### `cdk deploy` fails validating `CfnMicrovmImage`

Check `baseImageArn`/`baseImageVersion` in `parameters/dev-params.ts` -- the placeholders will fail at deploy
time. Re-run `aws lambda-microvms list-managed-microvm-images` for current values.

### `AWS::Lambda::MicrovmImage ... did not stabilize` with zero application logs

Almost always means your in-VM server is answering hook requests at the wrong path. Lambda calls
lifecycle hooks as **`POST /aws/lambda-microvms/runtime/v1/<hook-name>`**, not bare paths like
`/ready` -- a server that only recognizes `/ready` gets a 404 on every call and the build just
times out, with nothing informative logged (the 404 itself is never surfaced as an error since the
application "successfully" handled the request, just with the wrong response). Check the build's
`MicrovmImageLogGroup` -- if you see the server's own "listening" line but no follow-up activity at
all, this is the likely cause. See `docs/knowledge/lambda-microvms.md` for the full writeup.

If the build log group has **zero log streams whatsoever** (not even a "listening" line), check
that the build role has `logs:CreateLogStream`/`PutLogEvents` on the configured log group --
`logging.cloudWatch.logGroup` alone doesn't imply write access.

### `RunMicrovm` fails with `AccessDeniedException` naming `lambda:RunMicrovm`, `lambda:PassNetworkConnector`, or `secretsmanager:GetSecretValue`

- `lambda:RunMicrovm` (or any other MicroVM data-plane action): confirm the IAM policy uses the
  `lambda:` action prefix, not `lambda-microvms:` -- despite the dedicated SDK/CLI namespace, IAM
  authorizes these under core Lambda.
- `lambda:PassNetworkConnector`: `RunMicrovmRequest.egressNetworkConnectors` needs a `PassRole`-like
  grant on the connector's own ARN. If the error instead names
  `arn:...:network-connector:aws-network-connector:HTTP_INGRESS` (an AWS-managed ARN you never
  referenced), `RunMicrovm` implicitly attaches a default ingress connector even when
  `ingressNetworkConnectors` is left unset -- grant `PassNetworkConnector` on
  `arn:<partition>:lambda:<region>:aws:network-connector:aws-network-connector:*` too.
- `secretsmanager:GetSecretValue` naming the **build role** (not the execution role): your
  application resolves a secret during startup, and the build's `/ready`/`/validate` hook runs
  under build-role credentials, not the execution role's -- grant the build role the same
  read-time permissions.

If a fix for any of these still fails identically immediately after `cdk deploy` reports success,
suspect IAM propagation lag rather than a wrong fix -- confirm the deployed template
(`aws cloudformation get-template`) already has the right policy, then retry after a short wait.

### `RunMicrovm` succeeds but `POST {endpoint}/rpc` never responds

Check the MicroVM's CloudWatch log group (`MicrovmImageLogGroup`) for `[server]`/`[codex app-server]` log
lines. If the in-VM server never logs "listening", the container's `ENTRYPOINT` may be failing before
`server/index.mjs` binds its port -- check for an `npm install` failure baked into the image, or
`codex app-server` exiting immediately with `CODEX_HOME points to "..." but that path does not
exist` (setting `ENV CODEX_HOME=...` in the Dockerfile does not create the directory -- a
`RUN mkdir -p "$CODEX_HOME"` step is required).

### `GET /sessions/{id}/events` always returns an empty list

Confirm `create-session` sent `runHookPayload` -- if the in-VM server's `/run` handler never received a
`sessionId`, the Event Handler drops every line rather than writing it unattributed (see
`server/event-handler.mjs`).

### WebSocket connection closes immediately with code 1008 (or `$connect` returns 401/404)

- 401-shaped rejection: `ws-authorizer` could not verify the `token` query parameter -- check it's a Cognito
  **ID** token (not an access token) for the same user pool/client the stack deployed.
- 404-shaped rejection: `ws-connect` could not find a session matching `sessionId` owned by that token's
  `sub` -- confirm `POST /sessions` was called with the same Cognito user first.

### WebSocket connects but no events ever arrive

Check `ForwardEventFunctionLogGroup` for `GoneException`/other `PostToConnection` errors. If nothing is
logged at all, confirm the `EventsTable` DynamoDB Streams-triggered `AWS::Lambda::EventSourceMapping` is
`Enabled` and that events are actually being written (see the previous item).

### `codex app-server` starts but immediately fails authentication

The `OPENAI_API_KEY_SECRET_ARN` environment variable resolves to a Secrets Manager secret whose value is
still the placeholder created at first deploy -- run the `put-secret-value` command from the Deployment Guide.

## 🧹 Clean-up

```sh
npm run destroy:all -w workspaces/lambda-microvms-codex-appserver --project=<project> --env=dev
```

Terminate any still-RUNNING/SUSPENDED sessions (`DELETE /sessions/{id}`) before destroying the stack --
`TerminateMicrovm` is not called automatically by `cdk destroy`.

## 📚 References

### AWS Documentation

- [AWS Lambda MicroVMs](https://aws.amazon.com/lambda/lambda-microvms/)
- [Announcing Lambda MicroVMs (AWS Compute Blog)](https://aws.amazon.com/blogs/compute/announcing-lambda-microvms-serverless-compute-environments-with-vm-level-isolation-and-near-instant-startup/)
- [API Gateway WebSocket APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api.html)

### Codex

- [OpenAI Codex CLI (`codex app-server`)](https://github.com/openai/codex)

### Related Architectures

- [`apigw-lambda-web-adapter`](../apigw-lambda-web-adapter/README.md) -- the API Gateway + Lambda pattern this control plane's HTTP routing follows.

## 📄 License

This project is licensed under the Apache License, Version 2.0 - see the [LICENSE](../../../LICENSE) file for details.

## 👥 Contributing

Contributions are welcome! See the [Contribution Guide](../../../docs/contribution/CONTRIBUTING.md).

## 🏆 About This Reference Architecture

This reference architecture demonstrates AWS CDK best practices for building a VM-isolated, session-based serverless compute backend.

**Target Level**: 300 (Advanced)

---

**Note**: This is a reference implementation. Always review and customize according to your specific requirements and organizational policies before deploying to production.
