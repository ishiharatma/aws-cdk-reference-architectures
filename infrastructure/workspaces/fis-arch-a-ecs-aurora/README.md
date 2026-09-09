# FIS Chaos Engineering — Architecture A: CloudFront + Internal ALB + ECS Fargate + Aurora PostgreSQL

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20CloudFront%20%7C%20ALB%20%7C%20ECS%20Fargate%20%7C%20Aurora%20PostgreSQL-orange?style=flat-square)

## Introduction

This project is a reference implementation for AWS Fault Injection Simulator (FIS) chaos engineering on a **container-based three-tier web architecture**. A CloudFront distribution routes traffic via VPC Origin to an internal Application Load Balancer, which forwards requests to ECS Fargate tasks running nginx, which connect to an Aurora PostgreSQL Serverless v2 cluster.

Four FIS experiment templates inject distinct failure modes across the data, compute, and network tiers, covering the realistic failure scenarios operators need to validate before production:

| Scenario | Fault Injected | Duration | What It Validates |
| -------- | -------------- | -------- | ----------------- |
| **A-1** Aurora DB Failover | `aws:rds:failover-db-cluster` — triggers writer→reader promotion | ~5 min | Connection pool recovery, retry logic, RDS reconnect behavior |
| **A-2** ECS All-Tasks Stop | `aws:ecs:stop-task` — terminates all running ECS tasks simultaneously | 5 min | ALB 503 handling, CloudFront fallback error page activation, ECS service recovery speed |
| **A-3** ECS→DB Network Blackhole | `aws:ecs:network-blackhole-port` — blocks TCP 5432 egress from ECS tasks | 5 min | Query-timeout settings, circuit-breaker patterns, graceful degradation when DB is unreachable |
| **A-4** ALB→ECS Network Blackhole | `aws:ecs:network-blackhole-port` — blocks TCP 80 ingress to ECS tasks | 5 min | ALB unhealthy-host detection speed, CloudFront fallback activation |

All experiments share a CloudWatch Alarm stop condition that automatically halts the experiment if the ALB 5xx error count exceeds 10 per minute.

## Architecture Overview

```
Viewer (HTTPS)
    │
    ▼
CloudFront Distribution  (VPC Origin primary, S3 error page fallback)
    │  Origin Group: primary=VPC Origin, fallback on 502/503/504
    ▼
Internal ALB  (Private subnet, CloudFront prefix list ingress only)
    │  HTTP/80 → ECS Fargate target group
    ▼
ECS Fargate Service  (nginx, 2 tasks, enableExecuteCommand=true)
    │  TCP 5432
    ▼
Aurora PostgreSQL Serverless v2  (1 writer + 1 reader, Isolated subnet)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIS Experiment Templates (FisStack)

A-1  aws:rds:failover-db-cluster ──────────► Aurora cluster
     Triggers writer→reader promotion

A-2  aws:ecs:stop-task ─────────────────────► ECS tasks (ALL)
     Stops all tasks; ECS scheduler launches replacements

A-3  aws:ecs:network-blackhole-port ────────► ECS tasks (ALL)
     egress TCP 5432 blocked for 5 min

A-4  aws:ecs:network-blackhole-port ────────► ECS tasks (ALL)
     ingress TCP 80 blocked for 5 min
```

### VPC Layout

```
VPC 10.10.0.0/16 (2 AZs)
  Public subnet  /24 ×2   — NAT Gateway, CloudFront VPC Origin ENIs
  Private subnet /24 ×2   — Internal ALB, ECS Fargate tasks
  Isolated subnet /24 ×2  — Aurora PostgreSQL cluster
```

### Key Design Points

| Feature | Benefit |
| ------- | ------- |
| CloudFront VPC Origin → Internal ALB | ALB is unreachable from the public internet; CloudFront is the only ingress path |
| Origin Group with S3 fallback | When all ECS tasks are stopped (A-2) or network-blacked (A-4), CloudFront serves the maintenance page from S3 |
| `enableExecuteCommand: true` | Required for FIS `aws:ecs:network-blackhole-port` and `aws:ecs:stop-task` SSM-based actions |
| `propagateTags: SERVICE` | FIS targets ECS tasks by the `fis-target: app-service` tag propagated from the service |
| 1 writer + 1 reader on Aurora | Minimum required for `aws:rds:failover-db-cluster` to promote a reader |
| Shared stop condition | One CloudWatch Alarm (≥ 10 ALB 5xx / min) halts any of the four experiments automatically |

## Prerequisites

- AWS CLI v2 installed and configured
- Node.js 20 or later
- AWS CDK CLI (`npm install -g aws-cdk`)
- Basic knowledge of TypeScript and VPC networking
- AWS account with FIS service-linked role created (auto-created on first FIS use)

> **Cost note**: this architecture includes NAT Gateway charges (~$0.045/hour) and Aurora Serverless v2 minimum ACU charges. Destroy the stacks after experiments to avoid ongoing costs.

## Project Directory Structure

```text
fis-arch-a-ecs-aurora/
├── bin/
│   └── fis-arch-a-ecs-aurora.ts              # App entry point (Stage instantiation)
├── lib/
│   ├── stages/
│   │   └── fis-chaos-stage.ts                # Stage: BaseStack → AppStack → FisStack
│   └── stacks/
│       ├── base-stack.ts                     # VPC + Aurora PostgreSQL Serverless v2
│       ├── app-stack.ts                      # ECS Fargate + Internal ALB + CloudFront (VPC Origin)
│       └── fis-stack.ts                      # 4 FIS experiment templates + IAM + alarms
├── parameters/
│   ├── environments.ts                       # Environment parameter type
│   ├── dev-params.ts                         # Development environment parameters
│   └── index.ts                              # Parameter exports
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts                   # cdk-nag AwsSolutions compliance checks
│   └── snapshot/
│       └── snapshot.test.ts                  # CDK snapshot tests (11 test cases)
├── cdk.json
├── package.json
└── tsconfig.json
```

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
const devParams: EnvParams = {
    region: 'ap-northeast-1',
    // alarmEmail: 'ops@example.com',  // uncomment to receive alarm notifications
    // cloudfrontManagedPrefixList: 'pl-58a04531',  // ap-northeast-1 CloudFront prefix list
};
```

### 3. Bootstrap CDK (first time only)

```bash
PROJECT=fis-chaos ENV=dev npm run bootstrap
```

### 4. Deploy all stacks

```bash
PROJECT=fis-chaos ENV=dev npm run stage:deploy:all
```

This deploys the three stacks in dependency order:
1. `fis-chaos-dev-a-base` — VPC + Aurora cluster
2. `fis-chaos-dev-a-app` — ECS Fargate + Internal ALB + CloudFront
3. `fis-chaos-dev-a-fis` — FIS templates + IAM + alarms

### 5. Run a FIS experiment

Navigate to the AWS FIS console, select one of the four experiment templates (`A-1` through `A-4`), click **Start experiment**, and observe the ALB 5xx count and ECS service events in CloudWatch.

## Testing

```bash
cd infrastructure
npm ci

# Run all tests for this workspace
npm run test --workspace=fis-arch-a-ecs-aurora

# Snapshot tests only (11 test cases across 3 stacks)
npm run test:snapshot --workspace=fis-arch-a-ecs-aurora

# CDK Nag compliance checks
npm run test:compliance --workspace=fis-arch-a-ecs-aurora

# Update snapshots after intentional changes
npm run test:snapshot:update --workspace=fis-arch-a-ecs-aurora
```

### What the tests cover

| Test suite | File | Assertions |
| ---------- | ---- | ---------- |
| Snapshot | `test/snapshot/snapshot.test.ts` | Full CFn template snapshots for all 3 stacks; Aurora writer+reader count; ECS execute-command enabled; ALB is internal; exactly 4 FIS templates; all templates have stop conditions |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutions pack — no unsuppressed warnings or errors |

## Cost Estimation

| Service | Billing Model | Estimated monthly cost at rest |
| ------- | ------------- | ------------------------------ |
| Aurora Serverless v2 | Per ACU-hour (min 0.5 ACU) | ~$40–60/month at 0.5 ACU ×2 instances |
| NAT Gateway | $0.045/hour + data | ~$33/month + data transfer |
| ECS Fargate | Per vCPU/memory-hour | ~$5–10/month for 2 tasks (256 CPU, 512 MB) |
| ALB | Per LCU-hour | ~$17/month base |
| CloudFront | Per request + data | ~$0.01 for light experiment traffic |
| FIS | Free | No charge |
| **Total** | | **~$95–120/month** — destroy stacks after experiments |

## Security Considerations

- **ALB is internal**: the ALB is not internet-facing; CloudFront VPC Origin is the only path to reach it.
- **FIS role follows least privilege**: scoped to the specific ECS cluster, service, and Aurora cluster ARNs.
- **ECS task role uses SSM Exec permissions**: `ssmmessages:*` on `*` is required by the ECS Exec mechanism for FIS SSM-based fault injection. This is a documented requirement.
- **Stop condition is mandatory**: all FIS templates include the ALB error alarm stop condition, limiting maximum experiment blast radius.

## Clean-up

```bash
PROJECT=fis-chaos ENV=dev npm run stage:destroy:all
```

All resources have `removalPolicy: DESTROY`, so the destroy command removes the VPC, Aurora cluster, ECS service, ALB, CloudFront distribution, FIS templates, and CloudWatch log groups completely.

## Summary

This workspace demonstrates FIS chaos engineering on a container-based three-tier web architecture. The four scenarios cover distinct failure modes:

- **A-1** verifies that the application reconnects gracefully when Aurora promotes a reader to writer.
- **A-2** verifies that the ALB detects task termination and CloudFront activates the fallback error page.
- **A-3** verifies query-timeout and circuit-breaker behavior when the database is network-unreachable.
- **A-4** verifies that ALB health checks fail fast and CloudFront falls back to the S3 maintenance page.

## References

- [AWS FIS — Supported actions](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [aws:rds:failover-db-cluster action reference](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-rds)
- [aws:ecs:stop-task action reference](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-ecs)
- [aws:ecs:network-blackhole-port action reference](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-ecs)
- [CDK aws-fis module (L1 constructs)](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_fis-readme.html)
- [CloudFront VPC Origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html)
