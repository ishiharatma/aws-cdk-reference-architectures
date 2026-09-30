# Security Baseline: CloudTrail, Config, GuardDuty, Access Analyzer & Security Hub - AWS CDK Reference Architecture

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **Level: 200 (Intermediate)**

> ⚠️ **Draft — not deploy-verified.** This workspace synthesizes and passes its unit, snapshot and CDK Nag tests, but it has **not** been deployed to a real AWS account. Behavior described under [Known Risks](#-known-risks-not-verified) is expected from AWS documentation and service design, not observed. It is registered as `draft: true` in `pages/patterns.json` until it has been deploy-verified (see [`docs/knowledge/deploy-verification-workflow.md`](../../../docs/knowledge/deploy-verification-workflow.md)).

A **single-account security baseline**: an audit trail (**CloudTrail**), configuration history and rules (**AWS Config**), threat detection (**GuardDuty**), external/unused-access analysis (**IAM Access Analyzer**), and one place to read all findings (**Security Hub**), all in one CDK stack. **Detection only**: nothing here blocks an action, remediates a finding or sends a notification.

| Service | What this stack creates |
|---|---|
| **CloudTrail** | One multi-Region trail (management events, global service events, log file validation) → S3 (KMS-encrypted objects) and CloudWatch Logs |
| **AWS Config** | Recorder (all supported types, including global), delivery channel to the same bucket, 11 managed rules |
| **GuardDuty** | Detector with S3, EBS malware, RDS login and Lambda network protection plans (each a parameter) |
| **IAM Access Analyzer** | Account-scoped external-access analyzer; optional unused-access analyzer (paid, off in `dev`) |
| **Security Hub** | Hub subscribed to AWS Foundational Security Best Practices (extra standards via a parameter) |
| **Log archive** | One private, versioned, TLS-only S3 bucket with lifecycle expiration, and a CMK with rotation |

## 📑 Table of Contents

- [Architecture Overview](#-architecture-overview)
- [Design Decisions & Best Practices](#-design-decisions--best-practices)
- [Well-Architected Alignment](#-well-architected-alignment)
- [Cost Optimization](#-cost-optimization)
- [Security Considerations](#-security-considerations)
- [Known Risks (not verified)](#-known-risks-not-verified)
- [Prerequisites](#-prerequisites)
- [Deployment Guide](#-deployment-guide)
- [Testing Strategy](#-testing-strategy)
- [Customization](#-customization)
- [Clean-up](#-clean-up)
- [References](#-references)

## 🏗️ Architecture Overview

![Architecture Diagram](overview.drawio.svg)

### Key Components

- **`LogArchiveConstruct`** — the shared S3 bucket (block public access, versioning, `enforceSSL`, bucket-owner-enforced ownership, expiration after `logArchiveExpirationDays`) and the KMS key.
- **`CloudTrailConstruct`** — `cloudtrail.Trail`, multi-Region, delivered under the `cloudtrail/` prefix, log files encrypted with the CMK, CloudWatch Logs group with a parameterized retention.
- **`ConfigConstruct`** — recorder role (AWS managed `AWS_ConfigRole`), bucket-policy statements for Config delivery, recorder, delivery channel (`config/` prefix, 24-hour snapshots) and the managed rules.
- **`GuardDutyConstruct`**, **`AccessAnalyzerConstruct`**, **`SecurityHubConstruct`** — one detector, up to two analyzers, one hub plus one `AWS::SecurityHub::Standard` per subscribed standard.
- **`SecurityBaselineStack`** — wires the constructs together and orders them: Config before the hub, GuardDuty and Access Analyzer before the hub.

### Managed Config rules

`S3_BUCKET_LEVEL_PUBLIC_ACCESS_PROHIBITED`, `S3_BUCKET_PUBLIC_READ_PROHIBITED`, `S3_BUCKET_SSL_REQUESTS_ONLY`, `ROOT_ACCOUNT_MFA_ENABLED`, `IAM_ROOT_ACCESS_KEY_CHECK`, `IAM_USER_NO_POLICIES_CHECK`, `ACCESS_KEYS_ROTATED`, `CLOUD_TRAIL_ENABLED`, `EBS_ENCRYPTED_VOLUMES`, `RDS_STORAGE_ENCRYPTED`, `INCOMING_SSH_DISABLED`.

## 🎯 Design Decisions & Best Practices

### 1. Detection only, on purpose

Every service here observes. Nothing blocks (no SCPs, no preventive controls), remediates (no auto-remediation) or notifies (no EventBridge → SNS). A baseline that silently changes resources is a surprise in a shared account; findings are read in Security Hub. Alerting is the obvious next step and is out of scope here.

### 2. One bucket for CloudTrail and Config

One archive means one lifecycle, one bucket policy and one place to look. CloudTrail objects are encrypted with the CMK; Config objects use the bucket default (SSE-S3). Making Config use the CMK too would need key-policy or grant changes for the Config delivery path and is left as a hardening step.

### 3. The trail is multi-Region, the rest is one Region

A trail is cheap to make multi-Region and closes the "activity in a Region nobody looks at" gap. GuardDuty, Config, Security Hub and Access Analyzer are **per Region**: deploy the stack in each Region you use (or move to an organization-level design, see [Customization](#-customization)).

### 4. Security Hub after its producers

The hub depends on the Config recorder (Security Hub controls read Config data) and on GuardDuty and Access Analyzer, so the producers exist first. `enableDefaultStandards` is `false` on the hub so the standards subscribed are exactly the ones declared in the stack.

### 5. Paid options are parameters, and default to the cheaper choice

GuardDuty protection plans are individual booleans. The unused-access analyzer is billed per IAM role and user analyzed and is **off** in `dev`. Runtime Monitoring is not offered because it requires an agent rollout and is a separate decision.

### 6. Real managed-rule identifiers, checked by tests

Each managed rule is asserted by its `SourceIdentifier`, and every rule and the delivery channel is asserted to depend on the recorder. One identifier (`INCOMING_SSH_DISABLED`) has no CDK constant and is passed as a string.

### 7. Environment-specific parameters

`logArchiveExpirationDays`, `trailLogGroupRetentionDays`, `guardDuty.*`, `additionalSecurityHubStandardArns`, `enableUnusedAccessAnalyzer`, `unusedAccessAgeDays` in `parameters/<env>-params.ts`.

## 🏛️ Well-Architected Alignment

| Pillar | Implementation |
|---|---|
| **Operational Excellence** | Everything as code; Config history answers "what changed"; snapshot and unit tests pin the shape |
| **Security** | Audit trail with integrity validation; CMK with rotation; private, TLS-only archive; threat detection; Foundational Security Best Practices |
| **Reliability** | Multi-Region trail; versioned archive; no runtime components to fail |
| **Performance Efficiency** | Managed services only; no compute |
| **Cost Optimization** | Paid options are opt-in parameters; lifecycle expiration bounds storage |
| **Sustainability** | No compute; retention bounded by parameter |

## 💰 Cost Optimization

**No monthly total is given.** Unit prices for these services differ by Region and by volume, and this draft has not been deployed or measured, so a number here would be invented. What drives the bill:

| Service | Billed by | Lever |
|---|---|---|
| CloudTrail | Events delivered beyond the free copy of management events; CloudWatch Logs ingestion and storage for the log group | Management events only (no data events); `trailLogGroupRetentionDays` |
| AWS Config | Configuration items recorded and rule evaluations | Recording all resource types is the most expensive choice in a busy account; narrow the recording group or the rule set |
| GuardDuty | Analyzed log/event volume per protection plan | The four `guardDuty.*` booleans |
| Security Hub | Security checks and finding ingestion | Number of subscribed standards |
| Access Analyzer | External access is free; unused access is billed per IAM role/user analyzed | `enableUnusedAccessAnalyzer` |
| S3 | Storage, requests | `logArchiveExpirationDays` |
| KMS | Key and requests | — |

Check the current rates for your Region on the pricing pages: [CloudTrail](https://aws.amazon.com/cloudtrail/pricing/), [Config](https://aws.amazon.com/config/pricing/), [GuardDuty](https://aws.amazon.com/guardduty/pricing/), [Security Hub](https://aws.amazon.com/security-hub/pricing/), [IAM Access Analyzer](https://aws.amazon.com/iam/access-analyzer/pricing/).

## 🔒 Security Considerations

### Implemented
- ✅ CloudTrail log file validation, CMK encryption with rotation, multi-Region coverage
- ✅ Archive bucket: block public access, versioning, TLS-only, bucket-owner-enforced ownership
- ✅ Config delivery permitted to `config.amazonaws.com` only, for this account (`aws:SourceAccount`), `bucket-owner-full-control`, on the `config/` prefix only
- ✅ Findings from GuardDuty, Config and Access Analyzer aggregated in Security Hub

### CDK Nag suppressions (with reasons)

| Rule | Where | Why |
|---|---|---|
| `AwsSolutions-S1` | archive bucket | It is the terminal audit archive; server access logs would need a second bucket that itself needs logging |
| `AwsSolutions-IAM4` | Config recorder role | `AWS_ConfigRole` is the AWS managed policy documented for the recorder role and is maintained as new resource types appear |

### Out of scope (add per environment)
- **Alerting** on high-severity findings (EventBridge → SNS/Chatops), and **remediation**.
- **Organization-wide** enablement (delegated administrators, auto-enable for member accounts).
- **Preventive** controls (SCPs, permission boundaries) and CloudTrail **data events**.
- **Config with the CMK**, S3 **Object Lock** on the archive.

## ⚠️ Known Risks (not verified)

Expected from documentation and service design. **None of this has been observed**; confirm on the first real deploy.

- **These services are singletons per account and Region.** If a GuardDuty detector, a Security Hub hub or an AWS Config recorder/delivery channel already exists in the target Region, creating it from CloudFormation is expected to fail because the resource already exists. Import or remove the existing one first.
- **Config recorder ordering.** The delivery channel and rules are declared to depend on the recorder, and the channel on the bucket policy. If the first deploy fails on the delivery channel, check the bucket policy and the recorder first.
- **Security Hub controls need Config.** Controls that depend on Config show no data until the recorder is recording; the hub is ordered after it, but results are not immediate.
- **The trail's KMS key policy** is generated by the CDK `Trail` construct. If CloudTrail delivery fails with an access error, inspect that key policy first.
- **Retained resources.** With `isAutoDeleteObject: false` (production) the bucket and key are retained on stack deletion.

## 📋 Prerequisites

- AWS account bootstrapped for CDK; AWS CLI v2 with a profile named `${PROJECT}-${ENV}`; Node.js 20+
- **No existing** GuardDuty detector, Security Hub hub, or Config recorder/delivery channel in the target Region (see [Known Risks](#-known-risks-not-verified))

## 🚀 Deployment Guide

```bash
cd infrastructure
npm install
export PROJECT=<project> ENV=dev

npm run bootstrap        -w workspaces/security-baseline   # first time only
npm run synth            -w workspaces/security-baseline
npm run stage:deploy:all -w workspaces/security-baseline
```

After deployment, read findings in the Security Hub console. Foundational GuardDuty detection has no configuration; the fastest way to see a finding is GuardDuty's sample-findings feature in the console.

## 🧪 Testing Strategy

```bash
npm test -w workspaces/security-baseline   # 26 tests
```

| Type | Covers |
|---|---|
| Snapshot (2) | Template and resource counts |
| Unit (22) | Archive hardening and removal policy per environment, trail properties, Config recorder/channel/bucket policy/rules and their ordering, GuardDuty features (including disabled ones), both analyzers, hub, standards and ordering, outputs |
| Compliance (2) | CDK Nag `AwsSolutions` |

There is **no operational check script** (unlike `eventbridge-custom-bus`) because the stack has not been deployed.

## 🔄 Customization

- **More Config rules**: add identifiers to `MANAGED_RULES` in `lib/constructs/config-construct.ts`.
- **More standards**: `additionalSecurityHubStandardArns` (copy the ARN from the Security Hub console for your Region).
- **Other Regions**: deploy the stack per Region.
- **Organization**: for many accounts, use delegated administrators and organization-level enablement instead of per-account stacks.
- **Alerting**: an EventBridge rule on Security Hub findings to SNS.

## 🧹 Clean-up

```bash
npm run stage:destroy:all -w workspaces/security-baseline
```

The archive bucket and key are deleted in non-production (`isAutoDeleteObject: true`) and retained in production.

## 📚 References

### AWS Documentation
- [AWS CloudTrail User Guide](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html)
- [AWS Config Developer Guide](https://docs.aws.amazon.com/config/latest/developerguide/WhatIsConfig.html)
- [Amazon GuardDuty User Guide](https://docs.aws.amazon.com/guardduty/latest/ug/what-is-guardduty.html)
- [IAM Access Analyzer](https://docs.aws.amazon.com/IAM/latest/UserGuide/what-is-access-analyzer.html)
- [AWS Security Hub](https://docs.aws.amazon.com/securityhub/latest/userguide/what-is-securityhub.html)

### Related Architectures
- [iam-basics](../iam-basics/) — IAM roles, policies and users
- [s3-basics](../s3-basics/) — S3 bucket hardening options
- [eventbridge-custom-bus](../eventbridge-custom-bus/) — the event-routing building block for the alerting extension

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](../../LICENSE) file for details.

## 🏆 About This Reference Architecture

**Target Level**: 200 (Intermediate)

---

**Note**: This is a draft reference implementation, not deploy-verified. Review the [Known Risks](#-known-risks-not-verified) and add alerting, organization-level enablement and preventive controls before relying on it.
