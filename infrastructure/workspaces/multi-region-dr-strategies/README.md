# Multi-Region Disaster Recovery: Four Strategies Compared - AWS CDK Reference Architecture

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 400](https://img.shields.io/badge/Level-400-red?style=flat-square)

The four AWS disaster recovery strategies, **backup and restore**, **pilot light**, **warm standby** and **multi-site active-active**, built for the same small orders API in Tokyo (primary) and Osaka (DR) and **measured** with a drill script. Same application, same data, four designs: you read the recovery time (RTO), the data loss window (RPO) and the cost of each from the same stacks instead of from a diagram.

| Strategy | RPO | RTO (measured, tiny dataset) | What runs in the DR region while idle |
|---|---|---|---|
| Backup and restore | up to the backup interval (24 h here) | about 6 min or more: restore 256 s + compute deploy 84 s, once the copy exists | a backup vault only |
| Pilot light | about 1 s (0.2 to 1.6 s) | 84 s: deploy the compute stack | the data (global table replica) |
| Warm standby | about 1 s | 36 s: DNS failover 28 s + scale-up | data and the API, scaled to zero |
| Multi-site active-active | about 1 s | 34 s until the failed region leaves DNS; the other region was already serving | data and the API, serving traffic |

## 📑 Table of Contents

- [Architecture Overview](#️-architecture-overview)
- [Design Decisions & Best Practices](#-design-decisions--best-practices)
- [Choosing a Strategy](#-choosing-a-strategy)
- [Well-Architected Alignment](#️-well-architected-alignment)
- [Cost Optimization](#-cost-optimization)
- [Security Considerations](#-security-considerations)
- [Prerequisites](#-prerequisites)
- [Deployment Guide](#-deployment-guide)
- [Operational Check Script](#-operational-check-script)
- [Testing Strategy](#-testing-strategy)
- [Customization](#️-customization)
- [Troubleshooting](#-troubleshooting)
- [Clean-up](#-clean-up)
- [References](#-references)

## 🏗️ Architecture Overview

![Architecture Diagram](overview.drawio.svg)

### Key Components

- **Orders API** — one Lambda function per strategy and region, behind a function URL (Node.js 24, ARM64): `POST /orders`, `GET /orders/{id}`, `GET /health` (503 while `FAIL=true`, which is how the drill takes a region "down").
- **Backup and restore** — a single-region DynamoDB table (point-in-time recovery on), an AWS Backup plan with a daily rule that **copies** recovery points to a vault in the DR region. No compute in the DR region.
- **Pilot light** — a DynamoDB **global table** with a replica in the DR region. The DR compute is a separate stack (`DrRecoveryStack`), synthesized only with `-c includeRecoveryStack=true`: recovery means deploying it.
- **Warm standby** — a global table, the full API deployed in the DR region with **reserved concurrency 0**, and a Route 53 **failover** record (PRIMARY with a health check, SECONDARY to the standby).
- **Active-active** — a global table written from both regions, the API serving in both, and a **weighted 50/50** Route 53 record with a health check on each side.
- **DNS and probe** — a private hosted zone `dr.internal`, a small VPC, and a resolver Lambda inside it that resolves the records the way a real client does.
- **Stacks** — `dr-secondary` (DR region, deployed first), `dr-primary` (primary region, consumes it through cross-region references), `dr-recovery` (DR region, on demand).
- **`drill.sh`** — measures RPO and RTO for each strategy against the deployed stacks.

## 🎯 Design Decisions & Best Practices

### 1. One application, four DR designs

Comparing strategies only means something if the workload is held constant. All four use the same API and the same table shape, so the differences in the table above come from the DR design alone.

### 2. Warm standby on Lambda is "deployed, but scaled to zero"

A warm standby keeps a scaled-down copy of the workload running. With Lambda there is nothing to scale down, so the stack sets **reserved concurrency to 0**: the function exists and is configured, but every invocation is throttled (HTTP 429 from the function URL). Recovery is `delete-function-concurrency`, which takes effect within seconds. This is the same shape as scaling an ECS service from 0 or a minimum-size Auto Scaling group up.

### 3. Pilot light recovers the compute, not the data

The pilot light keeps the data live (the replica is written to continuously) and nothing else. In the drill, the replicated order is already in the DR table before any compute exists, and recovery is a `cdk deploy` of the compute stack: **84 s** from the command to a served request. The cost of that speed is paid daily, for the replica; the cost of the compute is paid only after a disaster.

### 4. Global tables give a replication lag of about a second, with last-writer-wins

DynamoDB global tables replicated every drill write to the other region within 0.2 to 1.6 s (measured from the acknowledgement in the primary region; the figure includes the CLI call that checks for the item). That is the RPO for the three strategies that use them. Concurrent writes to the same item in two regions resolve by last writer wins, so an active-active design needs keys or ownership rules that avoid conflicting writes.

### 5. Backup and restore: the copy, not the backup, is the slow part

On a tiny table the on-demand backup took 197 s, the cross-region copy finished 938 s after the backup started (about 12 minutes for the copy), and the restore in the DR region took 256 s. Recovery cannot start until the copy exists, so the effective RPO is the backup interval **plus** the copy time, and the RTO grows with the table size.

### 6. DNS failover has a floor: detection plus TTL

Warm standby and active-active both depend on Route 53 health checks (10 s interval, 2 failures) and a 10 s TTL. The measured DNS switch was 28 s for failover and 34 s for removing the failed region from a weighted record. During that window clients that already hold the old answer, and for active-active roughly half of new lookups, still reach the failed region.

### 7. What the drill does not cover

Failback (returning to the primary and re-synchronizing), real regional outages (the drill simulates failure with the health endpoint), and data-plane failover for clients that do not use the DNS name. A real runbook needs all three.

### 8. Environment-specific parameters

`parameters/<env>-params.ts` sets the regions, TTL, health check interval and threshold, the warm standby concurrency, and the backup schedule and retention.

## 🧭 Choosing a Strategy

| Question | Pointer |
|---|---|
| Can the business lose a day of data and wait hours? | Backup and restore. The cheapest, and the baseline for every other strategy. |
| Is minutes of downtime acceptable but data loss not? | Pilot light. |
| Does recovery have to be automatic in about a minute? | Warm standby: failover is DNS plus a scale-up. |
| Must both regions serve all the time, or must the outage be invisible? | Active-active, with a conflict-free write design. |

For a compute layer that does not scale to zero (ECS, EC2), the idle cost of warm standby is the standby capacity you keep running, and that is the main price difference between warm standby and pilot light.

## 🏛️ Well-Architected Alignment

| Pillar | How this architecture addresses it |
|---|---|
| Operational Excellence | `drill.sh` turns each strategy into measured numbers; all four are CloudFormation-managed |
| Security | Least-privilege per-function access to one table, KMS-encrypted backup vaults, isolated-subnet resolver probe |
| Reliability | Four recovery designs from daily backup to active-active, health-checked DNS, point-in-time recovery on every table |
| Performance Efficiency | ARM64 functions, replicated tables serve local reads in active-active |
| Cost Optimization | The cost of each design is explicit (below); idle cost scales with how much is kept warm |
| Sustainability | Serverless compute; standby capacity is zero until it is needed |

## 💰 Cost Optimization

Approximate monthly cost of the demo if left running, excluding usage (verify against the pricing pages):

| Item | Approx. |
|---|---|
| Route 53 health checks (3, HTTPS, fast interval) | about 7 to 9 USD (warm standby 1, active-active 2) |
| Private hosted zone | 0.50 USD |
| KMS keys for the two backup vaults | 2 USD |
| DynamoDB (on-demand, near-empty tables) and replicated writes | cents |
| Lambda, logs, AWS Backup storage and copy | cents |

The ranking by idle cost is backup and restore < pilot light < warm standby < active-active. The demo's numbers are small because Lambda and DynamoDB on-demand have no idle capacity; the same ranking with a container or instance compute layer is dominated by the standby capacity.

## 🔒 Security Considerations

### Implemented

- Each function can only `PutItem` and `GetItem` on its own table.
- Backup vaults are encrypted with their own KMS keys (rotation on); recovery points are copied inside the account.
- The resolver probe runs in an isolated subnet with no internet access.
- Function URLs are public because Route 53 health checkers cannot sign requests; they serve only the fixed demo API.

### CDK Nag suppressions (with reasons)

| Rule | Reason |
|---|---|
| AwsSolutions-IAM4 / IAM5 | AWS-recommended managed policies for Lambda and AWS Backup, and AWS-defined wildcards in them |
| AwsSolutions-VPC7 | The VPC only associates the private hosted zone and has no traffic to log |
| AwsSolutions-L1 | Runtime is the latest supported Node.js version at authoring time |
| AwsSolutions-DDB3 | Point-in-time recovery is enabled on every table; the rule does not recognise the `TableV2` form |

### Out of scope (add per environment)

Cross-account backup copies and Vault Lock (see `aws-backup-cross-region`), authorizers on the API, an alarm and runbook for the health checks.

## 📋 Prerequisites

- Node.js 24+, AWS CDK v2
- **CDK bootstrapped in both regions** (the DR region too). `npm run bootstrap -w workspaces/multi-region-dr-strategies` bootstraps every region used by the app
- `aws`, `curl`, `jq` for `drill.sh`

## 🚀 Deployment Guide

```bash
export PROJECT=<project> ENV=dev
npm install
npm run bootstrap -w workspaces/multi-region-dr-strategies          # both regions, once
npm run stage:deploy:all -w workspaces/multi-region-dr-strategies   # about 7 minutes
```

## 🧪 Operational Check Script

```bash
./drill.sh --project <project> --env <env>                 # all drills
./drill.sh --project <project> --env <env> --only warm-standby
```

| Drill | What it does |
|---|---|
| `rpo` | Writes to the primary, polls the DR replica, three times per global-table strategy |
| `warm-standby` | Takes the primary health endpoint down, times the DNS failover, scales the standby up, times the first served read of a replicated order |
| `active-active` | Checks both regions appear in answers, takes one down, times until every answer points at the other |
| `pilot-light` | Deploys the recovery stack from the DR region, times it until a replicated order is served, deletes it again |
| `backup-restore` | Runs an on-demand backup, copies it to the DR vault, restores it into a new table, checks the order, deletes the table |
| `cleanup` | Deletes the recovery points in both vaults (needed before destroy) |

Verified on 2026-10-04 in `ap-northeast-1` (primary) and `ap-northeast-3` (DR): every drill passed with the numbers in the table at the top. The script restores the health endpoints and the standby's concurrency on exit.

## 🧪 Testing Strategy

```bash
npm test -w workspaces/multi-region-dr-strategies
```

- **Snapshot**: every stack's template, with the recovery stack included, and resource counts per stack.
- **Unit**: stack regions, table kinds, backup rule and copy action, DR vault, standby concurrency, failover and weighted records, no pilot light compute in normal operation, recovery stack placement, least-privilege policies.
- **Compliance**: CDK Nag `AwsSolutionsChecks` on all three stacks.

## ⚙️ Customization

| Parameter | Meaning |
|---|---|
| `primaryRegion`, `drRegion` | The region pair |
| `recordTtl`, `healthCheckIntervalSeconds`, `healthCheckFailureThreshold` | DNS switch time versus cost and false positives |
| `warmStandbyConcurrency` | 0 = scaled to zero; a positive value keeps that much capacity answering |
| `backupScheduleCron`, `backupRetentionDays` | Backup RPO and storage cost |

## 🔧 Troubleshooting

### `cdk deploy` fails in the DR region with a missing bootstrap stack

The DR region was never bootstrapped. Run `npm run bootstrap` for this workspace; it bootstraps both regions.

### Destroy fails on a backup vault

A vault with recovery points cannot be deleted. Run `./drill.sh ... --only cleanup` first.

### The standby answers `429`

That is the point of reserved concurrency 0. Scale it up with `aws lambda delete-function-concurrency --function-name <project>-<env>-dr-ws --region <dr-region>`.

### The backup drill takes about 20 minutes

The cross-region copy is the slow step (about 12 minutes on a tiny table). Wait for it; the script polls.

## 🧹 Clean-up

```bash
./drill.sh --project <project> --env <env> --only cleanup
npm run stage:destroy:all -w workspaces/multi-region-dr-strategies
```

## 📚 References

- [Disaster recovery options in the cloud (AWS Well-Architected Reliability Pillar)](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html)
- [DynamoDB global tables](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html)
- [Creating backup copies across AWS Regions](https://docs.aws.amazon.com/aws-backup/latest/devguide/cross-region-backup.html)
- [Configuring DNS failover](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-configuring.html)
- [Configuring reserved concurrency for a function](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)
