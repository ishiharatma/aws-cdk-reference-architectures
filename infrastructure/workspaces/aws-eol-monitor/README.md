# AWS Service EOL Monitor — Serverless EOL Watch with a Bedrock Digest

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-200-yellow?style=flat-square)

> **Status: deploy-verified (2026-09-27).** Deployed against a real AWS account and run end-to-end: the Step Functions state machine was started manually and completed `FetchEolDiff` → `GenerateReport` (a real Bedrock `ConverseCommand` call) → `PublishReport` (a real SNS publish) successfully, then the stack was destroyed. See [Deploy verification](#deploy-verification) for what was checked and one real bug the deploy caught.

## Introduction

This project watches [`awslabs/aws-service-eol-data`](https://github.com/awslabs/aws-service-eol-data) — a machine-readable JSON dataset of AWS service/version end-of-life (EOL) dates (EKS, RDS engines, Lambda runtimes, ElastiCache, OpenSearch, and more) — for changes, and turns any change into a prioritized digest sent by email.

> The dataset's own README states it is **"NOT AN OFFICIAL AWS API. This is a community-maintained dataset provided on a best-effort basis"** with **"no guarantee of completeness, accuracy, or timeliness of updates."** Every entry's `sourceUrl` links to the official AWS documentation for independent verification — that page, not this dataset or the digest below, is the source of truth for any decision. See [Deploy verification](#deploy-verification) for how this affects `collector.datasetUrl`.

It is a serverless pipeline, on a schedule:

```text
EventBridge Scheduler (cron)
  └─→ Step Functions (Standard)
        1. FetchEolDiff    – Lambda: fetch eol.json, diff against DynamoDB state, upsert
        2. Choice: diffCount > 0 ?
             │ No  → NoChangesDetected (End)
             │ Yes ▼
        3. GenerateReport  – Lambda: ask Bedrock (Claude) to draft a prioritized
                              Markdown digest from the diff, in Japanese or English
        4. PublishReport   – Step Functions' native SNS integration
  └─→ SNS Topic → Email (add Slack/Teams via AWS Chatbot the same way the
      budgets-cost-anomaly-detection workspace does, if needed)

DynamoDB Table (Data stack)
  PK serviceCode / SK version — status, standardSupportEnd, notifiedUpcoming, lastCheckedAt
```

### Why a diff, not just a raw dump?

The dataset only has ~13 services today, but a naive "fetch and re-notify everything on every run" design doesn't scale and trains readers to ignore the digest. Instead, a DynamoDB table remembers the last-seen status of every `(serviceCode, version)` pair, so each run only reports what's *actually new*:

| Diff type | Fires when |
| --- | --- |
| `NEW` | A version is tracked for the first time |
| `STATUS_CHANGED` | `status` transitions, e.g. `STANDARD_SUPPORT` → `DEPRECATED` |
| `UPCOMING_EOL` | `standardSupportEnd` newly falls inside `collector.upcomingThresholdDays`, and hasn't already been flagged |

`UPCOMING_EOL` is flagged only once per version (`notifiedUpcoming` in DynamoDB) — no repeat pages every run while a date sits inside the window.

### Why Bedrock instead of a plain SNS text dump?

The Fetch step already produces a fully structured diff; a Lambda could format that into a fixed-template email with zero LLM calls, and for many teams that's the right call — it's cheaper and fully deterministic. Bedrock is used here specifically to demonstrate **Idea D** from the underlying survey of dataset use cases: turning structured EOL facts into a *prioritized, readable-by-non-experts* narrative (which items are urgent vs. informational, in the requested language) without hand-writing that logic. The prompt passes the diff JSON as the only source of facts and explicitly instructs the model not to invent migration steps — see `src/lambda/generate-report/index.ts`.

## Architecture Overview

See the pipeline diagram above (this workspace ships a text diagram instead of `overview.drawio.svg` — see [Deploy verification](#deploy-verification)).

### Key Components

- **Data stack** — a single DynamoDB table (`TableV2`, on-demand billing, PITR enabled), the diff state store.
- **Application stack**
  - `FetchEolDiffFunction` (Node.js 22, arm64) — fetches `eol.json` over plain `fetch()`, scans the state table, computes the diff, upserts new state.
  - `GenerateReportFunction` (Node.js 22, arm64) — calls Bedrock's `ConverseCommand` with the diff and a locale-aware prompt; returns `{ subject, body }`.
  - A **Standard** Step Functions state machine (JSONPath) chaining the two Lambdas through a `Choice` state, publishing to SNS via the native `SnsPublish` task (no third Lambda needed for delivery).
  - An **EventBridge Scheduler** schedule (cron + time zone) starting the state machine.
  - An **SNS Topic** with an email subscription per `notification.emails`.

### Parameters (`parameters/dev-params.ts`)

| Key | Meaning |
| --- | --- |
| `collector.datasetUrl` | Raw URL of the dataset's `data/eol.json`. Pinned to `main` in the sample — pin to a tag/commit for production so an upstream schema change can't silently break the parser. |
| `collector.upcomingThresholdDays` | A version's `standardSupportEnd` inside this many days counts as `UPCOMING_EOL`. |
| `schedule.scheduleExpression` / `scheduleTimeZone` | EventBridge Scheduler cron + IANA time zone. |
| `report.bedrockModelId` | Bedrock model ID or cross-region inference profile ID (must be enabled for the account/region). |
| `report.locale` | `'ja'` or `'en'` — controls both the Bedrock prompt and the SNS subject line. |
| `notification.emails` | SNS email subscribers. Replace the placeholder before deploying. |

## Deploy

```sh
# from infrastructure/workspaces/aws-eol-monitor
npm install
PROJECT=myproj ENV=dev npm run bootstrap   # once per account/region
PROJECT=myproj ENV=dev npm run deploy:all
```

Before deploying:

1. Edit `parameters/dev-params.ts` — a real `notification.emails` address, a `bedrockModelId` your account has model access to, and pin `collector.datasetUrl` to a tagged release (see [tags](https://github.com/awslabs/aws-service-eol-data/tags)) instead of `main`, per the dataset's own recommendation.
2. Confirm the SNS email subscription from the confirmation email after the first deploy — no digest is delivered until you do.
3. Request Bedrock model access for the chosen model in the target region if you haven't already (Bedrock console → Model access).

## Usage

The schedule fires automatically. To test on demand, start an execution of the `<project>-<env>-eol-monitor` state machine from the Step Functions console (no input required) — the first real run will report every currently-tracked version as `NEW`, which is expected and only happens once.

## Clean-up

```sh
PROJECT=myproj ENV=dev npm run destroy:all
```

The DynamoDB table's `RemovalPolicy` follows `isAutoDeleteObject` (destroy in non-production environments, retain otherwise) — check the stack before destroying in an environment where `ENV=prd`.

## 料金

Lambda (2 short invocations/run), Step Functions (Standard, a few state transitions/run), EventBridge Scheduler (1 schedule), DynamoDB (on-demand, a handful of items), SNS (email) are all low-volume and fall well within typical free tiers at a daily cadence. Bedrock Claude Converse calls are billed per input/output token and only happen on runs with a diff — the dominant cost driver of this design.

[AWS Pricing Calculator](https://calculator.aws/#/estimate) — no pre-built estimate is linked here; build one for your chosen Bedrock model, region, and schedule frequency.

## Deploy verification

Deployed to a real account (`ap-northeast-1`) and run end-to-end on 2026-09-27, then torn down. What was actually checked:

- `cdk deploy '**'` created both stacks cleanly (Data: the DynamoDB table; Application: both Lambdas, the Standard state machine, the SNS topic, the EventBridge Scheduler schedule).
- The state machine was started manually (`aws stepfunctions start-execution`, no input) and its execution history showed all three tasks actually run in order and succeed: `FetchEolDiff` → `HasDiff` (took the "has diff" branch, since a first run reports every tracked version as `NEW`) → `GenerateReport` → `PublishReport`.
- `GenerateReport`'s CloudWatch Logs confirmed a real ~22s Bedrock `ConverseCommand` call with no errors — not a mocked or skipped path.
- `PublishReport` (Step Functions' native SNS integration) returned a real `MessageId` with HTTP 200 from `sns:Publish`.
- The DynamoDB state table held 125 items after the run (one per tracked `(serviceCode, version)` pair) — the diff/state-write logic in `FetchEolDiff` is confirmed working, not just synthesizing correctly.
- **Bug found and fixed by this deploy**: `report.bedrockModelId` in `parameters/dev-params.ts` was `apac.anthropic.claude-sonnet-4-5-20250929-v1:0` — this inference profile ID does not exist (confirmed via `aws bedrock list-inference-profiles`, and a direct `bedrock-runtime converse` call against it fails). `cdk synth`/unit tests never catch this class of bug since the model ID is just a string from the model's perspective — only a real Bedrock call surfaces it. It's now `jp.anthropic.claude-sonnet-4-6`, listed and confirmed callable in this account/region via a direct `bedrock-runtime converse` call.
- Actual email delivery was **not** verified — `notification.emails` was left at its placeholder (`dev-team@example.com`), so no confirmation link exists to accept; the SNS `Publish` call succeeding (see above) confirms the pipeline reaches SNS correctly, but replace the placeholder with a real, confirmable address before relying on this for real notifications.
- Not covered by this pass: `STATUS_CHANGED`/`UPCOMING_EOL` diff types (the dataset's live content only produced `NEW` entries on this run), the EventBridge Scheduler actually firing on its cron (only a manual `start-execution` was used), and the "no diff" (`NoChangesDetected`) branch.

Other known gaps, unchanged by this pass:

- `test/unit` covers resource shape (Fine-grained Assertions) only — no snapshot, compliance (`cdk-nag`), or integration tests exist yet, unlike most workspaces in this repository.
- No `overview.drawio.svg` was produced; the ASCII diagram above stands in for it.
- Only a `dev` parameter set exists (no `prd-params.ts`).
- `collector.datasetUrl` still points at `main` in `parameters/dev-params.ts` for simplicity (this ran successfully against the live `main` branch during verification) — pin it to a tagged release before any production use (see the note in [Introduction](#introduction)).
