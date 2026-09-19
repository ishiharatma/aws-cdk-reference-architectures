# Serverless Codex App Server on AWS Lambda MicroVMs - AWS CDK Reference Architecture

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **Provenance note.** This reference was built from the AWS Lambda MicroVMs public documentation surface (the
> `@aws-sdk/client-lambda-microvms` API, the `AWS::Lambda::MicrovmImage` / `AWS::Lambda::NetworkConnector`
> CloudFormation resources, and public AWS announcements), not from a specific blog post -- the source article
> this workspace was requested from was unreachable from this environment's network egress policy at
> implementation time. Two details in particular are **unverified** against a citable AWS source and are called
> out again below: the IAM service principal Lambda MicroVMs assumes for build/execution roles, and the exact
> filesystem path convention the platform uses to locate each lifecycle hook's executable inside the image.
> Verify both against the current AWS Lambda MicroVMs Developer Guide before deploying to a real account.

## 📑 Table of Contents

- [Architecture Overview](#-architecture-overview)
- [Design Decisions & Best Practices](#-design-decisions--best-practices)
- [Well-Architected Alignment](#-well-architected-alignment)
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

![Architecture Overview](overview.drawio.svg)

A session **control plane** (API Gateway HTTP API + 5 Lambda functions) brokers the lifecycle of on-demand
**data plane** sessions: each session is a VM-isolated [AWS Lambda MicroVM](https://aws.amazon.com/lambda/lambda-microvms/)
running [`codex app-server`](https://github.com/openai/codex) (OpenAI Codex CLI's JSON-RPC agent protocol --
Thread/Turn/Item over a WebSocket transport). The control plane never proxies app-server traffic: once a session
starts, the client talks **directly** to the MicroVM's dedicated HTTPS endpoint, so every JSON-RPC round trip
stays on the VM-isolated path and the control plane's own Lambdas stay small and stateless.

```
Client (IDE / CLI / web UI)
   │  1. POST /sessions (Cognito JWT)
   ▼
API Gateway HTTP API ── JWT Authorizer (Cognito User Pool)
   │
   ▼
Control-plane Lambdas (create / get / delete / suspend / resume)
   │  RunMicrovm / GetMicrovm / SuspendMicrovm / ResumeMicrovm /
   │  TerminateMicrovm / CreateMicrovmAuthToken
   ▼
Lambda MicroVMs data plane
   │  launches a Firecracker microVM from the codex app-server image
   ▼
MicroVM (VM-isolated, dedicated HTTPS endpoint)
   codex app-server (WebSocket, JSON-RPC Thread/Turn/Item)
   ── egress via AWS::Lambda::NetworkConnector → NAT Gateway → OpenAI API

   │  2. WebSocket + X-aws-proxy-auth token, direct to the MicroVM endpoint
   ▼
Client ◄───────────────────────────────────────────────────────────────
```

### Key Components

| Component | Purpose |
|---|---|
| `AWS::Lambda::MicrovmImage` (`CfnMicrovmImage`) | Packages `src/microvm-image/Dockerfile` (Node.js + `@openai/codex` + lifecycle hook scripts) into a snapshotted MicroVM image. |
| `AWS::Lambda::NetworkConnector` + VPC (1 NAT Gateway) | The only way a MicroVM's `egressNetworkConnectors` can reach the internet (the OpenAI API); without it, `codex app-server` has no outbound network access at all. |
| Secrets Manager secret | Holds the OpenAI API key. Only its ARN is baked into the image (`OPENAI_API_KEY_SECRET_ARN`); the value is fetched inside the MicroVM at `run` time via the execution role. |
| 5 control-plane Lambdas | `create-session` (RunMicrovm + CreateMicrovmAuthToken), `get-session` (GetMicrovm), `delete-session` (TerminateMicrovm), `suspend-session` (SuspendMicrovm), `resume-session` (ResumeMicrovm + a fresh auth token). |
| DynamoDB `SessionsTable` | One item per session (`sessionId`, `ownerId`, `microvmId`, `endpoint`, `state`), TTL-expired automatically. |
| Cognito User Pool + HTTP API JWT Authorizer | Every control-plane route requires a valid Cognito JWT; `ownerId` scopes session reads/writes to their creator. |

### MicroVM lifecycle hooks

The image's Dockerfile installs 6 hook scripts under `/opt/hooks/`, one per lifecycle event
(`run`, `ready`, `suspend`, `resume`, `terminate`, `validate`). **Important:** `cdk synth`'s CloudFormation
Validate plugin confirmed that `Hooks.MicrovmHooks.*` and `Hooks.MicrovmImageHooks.*` are `ENABLED`/`DISABLED`
switches, not literal script paths -- the platform locates each hook's executable inside the image by a
filesystem convention this reference could not verify against a citable AWS source at authoring time. The
scripts are placed at the plausible `/opt/hooks/<hook>.sh` convention; confirm the real convention in the AWS
Lambda MicroVMs Developer Guide and adjust `src/microvm-image/Dockerfile` if it differs.

| Hook | When | What it does |
|---|---|---|
| `ready` / `validate` (image build) | After the Dockerfile's container starts / after the Firecracker snapshot is taken | Polls `nc -z 127.0.0.1 $CODEX_APP_SERVER_PORT` until `codex app-server` is listening. |
| `run` | MicroVM PENDING → RUNNING | Resolves the OpenAI API key from Secrets Manager, starts `codex app-server --listen ws://0.0.0.0:$PORT`. |
| `suspend` / `resume` | RUNNING ⇄ SUSPENDED | Log checkpoints only -- Firecracker's own memory+disk snapshot preserves the process (and any in-flight Thread/Turn/Item state) automatically. |
| `terminate` | Before the MicroVM is torn down | Best-effort graceful shutdown of `codex app-server`. |

## 🎯 Design Decisions & Best Practices

### 1. The control plane never proxies app-server traffic

`create-session` and `resume-session` return the MicroVM's own `endpoint` and a short-lived
`X-aws-proxy-auth` token (from `CreateMicrovmAuthToken`, scoped to a single port via `allowedPorts`). The
client connects to that endpoint directly. This keeps every JSON-RPC message on the VM-isolated path and
keeps the control-plane Lambdas' latency and cost independent of session traffic volume.

### 2. Suspend beats terminate for cost

`idlePolicy` auto-suspends an idle MicroVM (billed only for Firecracker snapshot storage) rather than
terminating it. `POST /sessions/{id}/suspend` and `/resume` let a client that knows a session is temporarily
unneeded (a closed tab) trigger that transition immediately instead of waiting out the idle timeout.

### 3. The OpenAI API key never enters the image or Infrastructure-as-Code

`CfnMicrovmImage.environmentVariables` carries only `OPENAI_API_KEY_SECRET_ARN` (a fixed value for every
session). `hooks/run.sh` resolves the actual secret value from Secrets Manager, using the credentials the
platform injects for the MicroVM's `executionRoleArn` -- see `src/microvm-image/hooks/fetch-secret.mjs`.

### 4. Sessions are owner-scoped end to end

The Cognito JWT's `sub` claim becomes `ownerId` on every `SessionsTable` item; `get/delete/suspend/resume`
all 404 on a session that isn't the caller's own, rather than leaking another user's MicroVM endpoint.

### 5. Environment-specific parameters, not hard-coded ARNs

`lib/types/microvm-image-params.ts` and `lib/types/control-plane-params.ts` define the tunables (base image
ARN/version, memory, idle/suspend timeouts, auth token TTL); `parameters/dev-params.ts` supplies the `dev`
values. **`baseImageArn`/`baseImageVersion` ship as placeholders** -- see Prerequisites.

## 🏛️ Well-Architected Alignment

| Pillar | How this reference addresses it |
|---|---|
| Operational Excellence | CloudWatch access logs on the HTTP API stage and a dedicated CloudWatch log group per control-plane Lambda and per MicroVM image. |
| Security | VM-level isolation per session (Firecracker, no shared kernel), Cognito JWT authorization on every route, owner-scoped session records, least-privilege DynamoDB/Secrets Manager grants. |
| Reliability | DynamoDB PAY_PER_REQUEST + point-in-time recovery; a single NAT Gateway is a deliberate cost/AZ-resilience tradeoff -- add a NAT Gateway per AZ for production. |
| Performance Efficiency | MicroVMs resume from a pre-initialized Firecracker snapshot instead of booting cold, so `codex app-server` is already listening when a session starts or resumes. |
| Cost Optimization | `idlePolicy` auto-suspend, DynamoDB TTL for expired sessions, PAY_PER_REQUEST billing throughout. |

## 💰 Cost Optimization

This reference introduces cost dimensions this repository's other patterns don't have (MicroVM run/suspend time,
a NAT Gateway, Cognito). **Do not treat any number here as a quote** -- always check the AWS Pricing pages for
Lambda MicroVMs, NAT Gateway, Cognito, and DynamoDB in your Region before estimating a real workload's cost.

Rough cost *drivers*, in the order they matter for this architecture:

1. **MicroVM RUNNING time** -- billed while a session's MicroVM is actively running (the main driver for a
   busy Codex session).
2. **MicroVM SUSPENDED time** -- billed only for Firecracker snapshot storage; this is why `idlePolicy` and
   the explicit `/suspend` route matter for cost, not just latency.
3. **NAT Gateway** -- an hourly charge plus per-GB data processing for every byte `codex app-server` sends
   to/from the OpenAI API. A single NAT Gateway (this reference's default) is the cheapest viable setup;
   consider VPC endpoints for any AWS service traffic MicroVMs need beyond internet egress.
4. **Cognito** -- free tier covers a meaningful number of MAUs before per-MAU billing starts; the Plus
   feature plan (`AwsSolutions-COG8`, suppressed here) adds further per-MAU cost if enabled.
5. **API Gateway HTTP API + control-plane Lambdas** -- negligible relative to the above: the control plane
   only brokers session lifecycle calls, not app-server traffic.
6. **DynamoDB** -- PAY_PER_REQUEST with a short TTL keeps this near-zero for typical session volumes.

### Cost notes specific to this pattern

- Tune `controlPlane.idleTimeoutInMinutes` down for cost-sensitive environments; a shorter idle window
  suspends unused MicroVMs sooner at the cost of a resume round trip on the next request.
- `controlPlane.suspendedDurationInMinutes` bounds how long you pay for snapshot storage before the platform
  terminates an abandoned session outright -- keep it aligned with `sessionRecordTtlInDays`.

## 🔒 Security Considerations

### Implemented

- VM-level isolation per session (Firecracker MicroVMs, no shared kernel between sessions).
- Cognito JWT authorization (`HttpUserPoolAuthorizer`) on every control-plane route.
- Owner-scoped session records (`ownerId` from the JWT `sub` claim).
- The OpenAI API key lives only in Secrets Manager; only its ARN is baked into the image.
- Least-privilege DynamoDB (`grantReadWriteData`, scoped to `SessionsTable`) and Secrets Manager
  (`grantRead`, scoped to the one secret) grants.
- Outbound-only security group for the MicroVM egress path (no inbound rules).

### Intentionally out of scope (add per environment)

- WAFv2 Web ACL on the HTTP API.
- Request body/schema validation beyond what the Lambda handlers check themselves.
- Cognito MFA and the Plus feature plan (advanced security features).
- VPC Flow Logs.
- Secrets Manager automatic rotation (not applicable to a third-party API key with no rotation Lambda; rotate
  manually).

### Two items to verify before production use

1. **IAM trust policy.** `microvmServicePrincipal` in the stack uses `lambda.amazonaws.com` as a best guess
   for the principal Lambda MicroVMs assumes to build images and run MicroVMs. Confirm the actual required
   principal (and any `sts:ExternalId`/condition keys) in the AWS Lambda MicroVMs Developer Guide.
2. **Hook executable path convention.** See "MicroVM lifecycle hooks" above.

### CDK Nag

`test/compliance/cdk-nag.test.ts` runs the `AwsSolutionsChecks` pack and asserts zero unsuppressed
warnings/errors. Every suppression carries a reason tied to one of the "intentionally out of scope" items
above, plus `AwsSolutions-IAM5` for the `lambda-microvms:*` actions (their resource ARNs -- MicroVM and image
identifiers -- are minted at `RunMicrovm` time and cannot be scoped ahead of deployment).

## 📋 Prerequisites

- Node.js 20.x+, the AWS CDK CLI, and an AWS profile as described in the repository root README.
- **A real MicroVM base image ARN and version.** `parameters/dev-params.ts` ships placeholders
  (`baseImageArn: 'arn:aws:lambda-microvms:...:image/REPLACE_ME'`). Discover real values with:
  ```sh
  aws lambda-microvms list-managed-microvm-images
  ```
  and update `parameters/dev-params.ts` before deploying.
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

# Connect directly to `endpoint` over WebSocket, sending the X-aws-proxy-auth header from `authToken`,
# and speak codex app-server's JSON-RPC protocol (initialize -> thread/turn/item) from there.

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

### Scope MicroVM data-plane IAM actions further

If your account exposes a stable ARN pattern for MicroVM/image resources, replace the `resources: ['*']` in
`microvmDataPlanePolicy` (`lib/stacks/lambda-microvms-codex-appserver-stack.ts`) with that pattern and drop
the corresponding `AwsSolutions-IAM5` suppression.

### Add a NAT Gateway per AZ

Change `natGateways: 1` to `natGateways: 2` in the `Vpc` construct for production-grade AZ resilience (at
roughly double the NAT Gateway cost).

### Front the control plane with a custom domain

Add a `DomainMappingOptions` (`aws-apigatewayv2` `HttpApi`) and an ACM certificate, following the same pattern
as `cloudfront-vpc-origin` elsewhere in this repository.

## 🔧 Troubleshooting

### `cdk deploy` fails validating `CfnMicrovmImage`

Check `baseImageArn`/`baseImageVersion` in `parameters/dev-params.ts` -- the placeholders will fail at deploy
time. Re-run `aws lambda-microvms list-managed-microvm-images` for current values.

### `RunMicrovm` succeeds but the client can never connect to `codex app-server`

Most likely the `run` hook never actually starts `codex app-server` because the platform could not locate its
executable at the hook path this reference guessed (`/opt/hooks/run.sh`). Check the MicroVM's CloudWatch log
group (`MicrovmImageLogGroup`) for the `[run]` log lines from `hooks/run.sh`; if they never appear, confirm
the real hook executable path convention against the AWS Lambda MicroVMs Developer Guide.

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

### Related Architectures

- [`apigw-lambda-web-adapter`](../apigw-lambda-web-adapter/README.md) -- the API Gateway + Lambda pattern this control plane's routing follows.

## 📄 License

This project is licensed under the Apache License, Version 2.0 - see the [LICENSE](../../../LICENSE) file for details.

## 👥 Contributing

Contributions are welcome! See the [Contribution Guide](../../../docs/contribution/CONTRIBUTING.md).
