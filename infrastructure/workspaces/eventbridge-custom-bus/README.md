# EventBridge Custom Bus: Content-Based Routing - AWS CDK Reference Architecture

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **Level: 300 (Intermediate)**

A **custom Amazon EventBridge event bus** for an order domain: producers publish facts (`OrderPlaced`, `PaymentFailed`, …) and **rules decide who reacts** using content-based event patterns — numeric, prefix and `anything-but` filters — with four different target types, bounded retries plus a dead-letter queue, bus-level logging, and an **archive that can be replayed**. Adding a consumer is adding a rule; no producer changes.

| Rule | Pattern | Target |
|---|---|---|
| `high-value` | `OrderPlaced` and `detail.amount >= 1000` (numeric) | SQS, with an **input transformer** |
| `eu-orders` | `OrderPlaced` and `detail.region` starts with `eu-` (prefix) | Lambda → DynamoDB (idempotent) |
| `payment-failed` | `PaymentFailed` and `detail.reason` is **not** `user_cancelled` (anything-but) | SQS |
| `audit` | every `app.orders` event | CloudWatch Logs, written by EventBridge itself (no Lambda) |

## 📑 Table of Contents

- [Architecture Overview](#-architecture-overview)
- [Design Decisions & Best Practices](#-design-decisions--best-practices)
- [Well-Architected Alignment](#-well-architected-alignment)
- [Cost Optimization](#-cost-optimization)
- [Security Considerations](#-security-considerations)
- [Prerequisites](#-prerequisites)
- [Deployment Guide](#-deployment-guide)
- [Operational Check Script](#-operational-check-script)
- [Testing Strategy](#-testing-strategy)
- [Customization](#-customization)
- [Troubleshooting](#-troubleshooting)
- [Clean-up](#-clean-up)
- [References](#-references)

## 🏗️ Architecture Overview

![Architecture Diagram](overview.drawio.svg)

### Key Components

- **Custom event bus** `orders` with `logConfig` (`INFO`, `FULL` detail) **and** the CloudWatch Logs delivery (`DeliverySource` → `DeliveryDestination` → `Delivery`) that actually writes those logs.
- **Archive** of every `app.orders` event (retention is a parameter) — the source for replays.
- **Four rules** (above), each also filtering on `source: app.orders`.
- **Targets** with a shared delivery policy: `maxEventAge` and `retryAttempts` from parameters, then the **target DLQ** (SQS, SSE, TLS-only, 14-day retention) with a CloudWatch alarm.
- **`processor` Lambda** (Node.js 24 / ARM64) — writes each EU order to DynamoDB keyed by `orderId` + `eventId`; `PutItem` only.
- **Queues** `high-value` and `payment-failed` (SSE-SQS, TLS-only).

## 🎯 Design Decisions & Best Practices

### 1. A custom bus, not the default bus

The default bus carries AWS service events for the whole account. A custom bus gives the domain its own **resource policy, archive, logging and blast radius**, and rules on it can never be triggered by unrelated events.

### 2. Producers publish facts; rules decide who reacts

`OrderPlaced` says what happened, not what should happen next. Consumers subscribe with rules, so a new consumer (an EU tax service, a fraud check) needs a rule and a target — never a producer change.

### 3. Every rule filters on `source` first

A rule without a `source` filter matches any producer that happens to use the same detail-type. All four rules pin `source: ["app.orders"]`; the check script proves an `OrderPlaced` from `other.app` (amount 9999) reaches **nothing**.

### 4. Patterns that do real work at the edge

- **numeric** `[">=", 1000]` — routes by business value without a Lambda.
- **prefix** `eu-` — partitions by region.
- **anything-but** — alerts on payment failures *except* the ones the customer caused. The threshold is a parameter and a unit test asserts the emitted pattern.

Filtering at the bus is cheaper than delivering everything and dropping it in code, and the pattern is visible infrastructure rather than hidden `if`s.

### 5. Input transformer for consumers that want a small contract

The high-value queue receives `{orderId, amount, region, tier}`, not the EventBridge envelope. Consumers depend on a purpose-built message, and envelope changes do not leak into them. Rules that are consumed generically (`payment-failed`, audit) get the whole event.

### 6. Bounded retries, bounded age, then a DLQ

EventBridge retries delivery with back-off. Without limits a permanently failing target retries for up to 24 hours by default. Here `retryAttempts` and `maxEventAge` are explicit, and what still fails lands in the **target DLQ** — with an alarm. (The DLQ receives events EventBridge could not *deliver*; for Lambda targets, errors *inside* the function are governed by the function's own asynchronous-invocation settings, not this DLQ.)

### 7. At-least-once delivery means idempotent consumers

EventBridge can deliver an event more than once, and a **replay** deliberately re-sends events a consumer has already seen. The processor writes by `orderId` + `eventId` with a plain `PutItem` (no read-modify-write), so a redelivery of the same event overwrites the same item. Design your own consumers to be idempotent on a business key; this reference does not replay into the Lambda rule (the replay in the check script is restricted to the queue rule).

### 8. Logging needs two resources, not one

`logConfig` only chooses *what* the bus logs. Nothing is written until a CloudWatch Logs **delivery** connects the bus (delivery source) to a log group (delivery destination). This stack creates both; the log group name follows the `/aws/vendedlogs/events/event-bus/<bus>` convention.

### 9. Audit without Lambda

The `audit` rule targets a log group directly. EventBridge writes the whole event; there is nothing to deploy, patch or pay per invocation.

### 10. Archive and replay

Every `app.orders` event is archived. A replay re-sends a time window of the archive **into the bus**, optionally **restricted to specific rules** (`FilterArns`) — here only `high-value`, so audit and the Lambda are not touched. Use it to rebuild a new consumer's state or recover after an outage. The check script waits for the archive to record the events, replays them, and asserts the high-value queue receives them again.

### 11. Environment-specific parameters

`highValueThreshold`, `archiveRetentionDays`, `targetMaxEventAgeMinutes`, `targetRetryAttempts` in `parameters/<env>-params.ts`.

## 🏛️ Well-Architected Alignment

| Pillar | Implementation |
|---|---|
| **Operational Excellence** | Bus logs and audit log group; DLQ alarm; `test-eventbus.sh` proves routing, exclusions and replay; snapshot/unit/Nag tests |
| **Security** | Source-pinned rules; least-privilege (processor: `PutItem` only; EventBridge → target permissions generated per target); SSE on queues/table, TLS-only queues |
| **Reliability** | Bounded retries + DLQ + alarm; idempotent consumer; archive + replay for recovery |
| **Performance Efficiency** | Filtering at the bus; audit without Lambda; ARM64 |
| **Cost Optimization** | Pay per event; no polling; filtering avoids needless invocations |
| **Sustainability** | Serverless, event-driven; nothing runs between events |

## 💰 Cost Optimization

EventBridge custom-bus events are billed per million events (events from AWS services on the default bus are free; custom and partner events are not). Archive storage and replay are billed separately; delivery to SQS/Lambda/Logs has no extra EventBridge charge beyond the event itself. Check the [EventBridge pricing page](https://aws.amazon.com/eventbridge/pricing/) for the current rates in your Region.

```
1,000,000 events / month (custom bus)          ≈ $1.00   (per-million rate; verify for your Region)
Lambda (EU subset, ~30%), 128 MB arm64          ≈ $0.10
DynamoDB on-demand (~300k writes)               ≈ $0.40
SQS (2 queues, ~1M requests)                    ≈ $0.40
CloudWatch Logs (audit + bus logs, ~2 GB)       ≈ $1.00
Archive (~1 GB, 1 day retention)                ≈ pennies
--------------------------------------------------------------
≈ $3 / month, estimate
```

Levers: filter early (fewer targets invoked), shorten archive retention, use the input transformer to shrink messages, sample or shorten log retention for `INFO`/`FULL` bus logs (use `ERROR` level in busy environments).

## 🔒 Security Considerations

### Implemented
- ✅ Rules pin `source`; the check script proves a foreign source matches nothing
- ✅ Least-privilege IAM: the processor can only `PutItem`; each target grant is generated for that target only
- ✅ SSE-SQS, TLS-only queue policies, DynamoDB SSE + PITR
- ✅ DLQ + alarm for undeliverable events

### CDK Nag suppressions (with reasons)

| Rule | Why |
|---|---|
| `AwsSolutions-IAM4` / `IAM5` / `L1` | the CloudWatch Logs target helper and its log-resource-policy custom resource are generated by the CDK library (managed policy, stream wildcard, library-managed runtime) |
| `AwsSolutions-SQS3` | the target DLQ is itself the dead-letter destination; the work queues are terminal targets |

### Out of scope (add per environment)
- **Bus resource policy** for cross-account producers (`bus.grantPutEventsTo`, or a policy scoped to an organisation) and a bus-level KMS key (`kmsKey`).
- **Schema registry** discovery/validation of `detail`.
- Restrict who may `PutEvents` and `StartReplay` (replay re-sends real events to real consumers).

## 📋 Prerequisites

- AWS account bootstrapped for CDK; AWS CLI v2 with a profile named `${PROJECT}-${ENV}`; Node.js 20+; `jq` for the check script

## 🚀 Deployment Guide

```bash
cd infrastructure
npm install
export PROJECT=<project> ENV=dev

npm run bootstrap        -w workspaces/eventbridge-custom-bus   # first time only
npm run synth            -w workspaces/eventbridge-custom-bus
npm run stage:deploy:all -w workspaces/eventbridge-custom-bus
```

Publish an event:

```bash
aws events put-events --entries '[{"EventBusName":"<project>-<env>-ebus-orders","Source":"app.orders","DetailType":"OrderPlaced","Detail":"{\"orderId\":\"o-1\",\"amount\":1500,\"region\":\"eu-west-1\"}"}]'
```

## 🧪 Operational Check Script

Matching is the whole point of this pattern, and a clean `cdk deploy` proves none of it. [`test-eventbus.sh`](./test-eventbus.sh) publishes 7 controlled events and asserts where each lands:

```bash
./test-eventbus.sh --project <project> --env dev                # full run incl. archive replay (several minutes)
./test-eventbus.sh --project <project> --env dev --skip-replay  # routing only
./test-eventbus.sh --project <project> --env dev --destroy      # ... then delete the stack
```

| Event | Lands in |
|---|---|
| E1 `OrderPlaced` 1500 us-east-1 | high-value queue, audit |
| E2 `OrderPlaced` 50 eu-west-1 | Lambda/DynamoDB, audit |
| E3 `OrderPlaced` 2000 eu-central-1 | high-value queue **and** Lambda, audit |
| E4 `PaymentFailed` card_declined | payment queue, audit |
| E5 `OrderCancelled` 5000 | **audit only** (detail-type filter) |
| E6 `OrderPlaced` 9999, source `other.app` | **nothing** (source filter) |
| E7 `PaymentFailed` user_cancelled | **audit only** (anything-but) |

It also asserts the transformed payload shape, an empty DLQ, then waits for the **archive** to record the events, **replays** them into the bus (filtered to the high-value rule) and asserts the queue receives E1 and E3 again. Requires `aws` and `jq`.

## 🧪 Testing Strategy

```bash
npm test -w workspaces/eventbridge-custom-bus   # 20 tests
```

| Type | Covers |
|---|---|
| Snapshot (2) | template + resource counts (Lambda asset hashes normalised) |
| Unit (16) | bus + logging + delivery, archive, the exact event pattern of each rule, threshold parameter, retry/age/DLQ on targets, input transformer, direct Logs target, queue hardening, IAM action sets, alarm, outputs |
| Compliance (2) | CDK Nag `AwsSolutions` |
| Operational | `test-eventbus.sh` against a deployed stack |

## ⚙️ Customization

- **A new consumer**: add an `events.Rule` on the bus with a pattern and a target — producers stay untouched.
- **Other targets**: Step Functions, SNS, Kinesis Firehose, API destinations (HTTP with auth and rate limit), another bus or account.
- **Cross-account**: add a bus resource policy allowing `events:PutEvents` from specific accounts/an organisation; the sender puts to the bus ARN.
- **Schema registry**: enable discovery on the bus to infer schemas from real events, then generate code bindings.
- **Bus-level DLQ / KMS**: `deadLetterQueue` and `kmsKey` on the `EventBus`.

## 🔧 Troubleshooting

### A rule "does nothing"
Check, in order: the bus name in `PutEvents`; the rule is on that bus and ENABLED; the pattern (a numeric filter needs a JSON **number**, not `"1500"`; `detail` is matched on the parsed JSON, so `Detail` must be valid JSON); then the bus log group `/aws/vendedlogs/events/event-bus/<bus>`, which records matches and deliveries.

### No bus logs appear
`logConfig` alone writes nothing. A CloudWatch Logs delivery (source → destination → delivery) must exist — this stack creates it.

### An event matched but the target did not receive it
Look in the target DLQ and at the rule's `FailedInvocations` metric. For SQS the queue policy must allow `events.amazonaws.com` from the rule ARN (generated by the target helper).

### The Lambda ran twice for one order
Delivery is at-least-once. The write is a plain `PutItem` keyed by `orderId` + `eventId`, so a redelivery of the same event overwrites the same item; keep any side effects you add idempotent too.

### Replay finished but nothing arrived
A replay honours `FilterArns`; if the rule ARN is not in the list its target is skipped. Also check the replay window: the start/end must cover the archived events, and the archive can lag the live bus by minutes.

### `cdk deploy` fails with "no credentials" after a while
The bundled CDK cannot refresh an expired SSO token; export short-lived credentials (`aws configure export-credentials --format env`) or `aws sso login`.

## 🧹 Clean-up

```bash
npm run stage:destroy:all -w workspaces/eventbridge-custom-bus   # or: ./test-eventbus.sh ... --destroy
```

## 📚 References

### AWS Documentation
- [Amazon EventBridge event patterns (content filtering)](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns-content-based-filtering.html)
- [Archiving and replaying events](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-archive.html)
- [EventBridge event bus logs](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-bus-logs.html)
- [Dead-letter queues and retry policy for targets](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-dlq.html)

### Related Architectures
- [sqs-lambda-firehose](../sqs-lambda-firehose/) — queue-based event pipeline
- [sns-basic](../sns-basic/) — pub/sub fan-out with SNS
- [budgets-cost-anomaly-detection](../budgets-cost-anomaly-detection/) — EventBridge-driven notifications

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](../../LICENSE) file for details.

## 👥 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](../../CONTRIBUTING.md) for details.

## 🏆 About This Reference Architecture

**Target Level**: 300 (Intermediate)

---

**Note**: This is a reference implementation. Add a bus resource policy, encryption and access controls appropriate to your domain before production use.
