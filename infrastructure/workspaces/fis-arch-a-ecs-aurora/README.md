# FIS Chaos Engineering — Architecture A: CloudFront + Internal ALB + ECS Fargate + Aurora PostgreSQL

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20CloudFront%20%7C%20ALB%20%7C%20ECS%20Fargate%20%7C%20Aurora%20PostgreSQL-orange?style=flat-square)

## Introduction

This project is a reference implementation for AWS Fault Injection Service (FIS) chaos engineering on a **container-based three-tier web architecture**. A CloudFront distribution routes traffic via VPC Origin to an internal Application Load Balancer, which forwards requests to ECS Fargate tasks running nginx, which are wired to an Aurora PostgreSQL Serverless v2 cluster (1 writer + 1 reader).

Four FIS experiment templates inject faults across the data, compute, and network tiers:

| Scenario | Fault Injected | Duration | What It Validates |
| -------- | -------------- | -------- | ----------------- |
| **A-1** Aurora DB Failover | `aws:rds:failover-db-cluster` — writer→reader promotion | ~30 s effect | Connection-pool reconnect, retry logic, RDS reconnect behaviour |
| **A-2** ECS All-Tasks Stop | `aws:ecs:stop-task` — stops every running task | one-shot | ALB target draining, CloudFront fallback, ECS self-healing speed |
| **A-3** ECS→DB Network Blackhole | `aws:ecs:task-network-blackhole-port` — TCP 5432 **egress** blocked | 5 min | Query-timeout settings, circuit-breaker patterns, graceful degradation when the DB is unreachable |
| **A-4** ALB→ECS Network Blackhole | `aws:ecs:task-network-blackhole-port` — TCP 80 **ingress** blocked | 5 min | ALB unhealthy-host detection, CloudFront S3 fallback, ECS task-replacement recovery |

All four share a CloudWatch Alarm stop condition that halts the experiment if the ALB target 5xx count exceeds 50 per minute.

> ### ⚠️ The `aws:ecs:task-*` actions are not plug-and-play
> A-3 and A-4 require an **`amazon-ssm-agent` sidecar container** in the task definition, `enableFaultInjection: true`, `pidMode: task`, and ECS Exec **disabled**. An earlier version used the non-existent action ID `aws:ecs:network-blackhole-port` and relied on ECS Exec — both are wrong. See [The FIS SSM sidecar](#the-fis-ssm-sidecar-a-3--a-4).

## Architecture Overview

```
Viewer (HTTPS)
    │
    ▼
CloudFront Distribution  (Origin Group: VPC Origin primary → S3 error page on 502/503/504)
    │  behavior: GET/HEAD/OPTIONS only (an origin group forbids write methods)
    ▼
Internal ALB  (Private subnet, CloudFront managed-prefix-list ingress only)
    │  HTTP/80 → ECS Fargate IP target group
    ▼
ECS Fargate Service  (nginx + amazon-ssm-agent sidecar, 2 tasks,
    │                  pidMode=task, enableFaultInjection=true, ECS Exec OFF)
    │  TCP 5432 (wired but the nginx demo does not open a DB connection)
    ▼
Aurora PostgreSQL Serverless v2 16.13  (1 writer + 1 reader, Isolated subnet, 0.5–4 ACU)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIS Experiment Templates (FisStack)

A-1  aws:rds:failover-db-cluster ─────────────────────► aws:rds:cluster (Aurora ARN)
A-2  aws:ecs:stop-task ───────────────────────────────► aws:ecs:task  (cluster + service params)
A-3  aws:ecs:task-network-blackhole-port ─────────────► aws:ecs:task  egress tcp/5432, PT5M,
                                                         useEcsFaultInjectionEndpoints=true
A-4  aws:ecs:task-network-blackhole-port ─────────────► aws:ecs:task  ingress tcp/80, PT5M,
                                                         useEcsFaultInjectionEndpoints=true
```

### VPC Layout

```
VPC 10.10.0.0/16 (2 AZs)
  Public subnet  /24 ×2   — 1 NAT Gateway, CloudFront VPC Origin ENIs
  Private subnet /24 ×2   — Internal ALB, ECS Fargate tasks
  Isolated subnet /24 ×2  — Aurora PostgreSQL cluster
```

### Key Design Points

| Feature | Rationale |
| ------- | --------- |
| CloudFront VPC Origin → Internal ALB | The ALB is unreachable from the public internet; CloudFront is the only ingress path |
| Origin Group with S3 fallback | When ECS tasks are stopped (A-2) or network-blackholed (A-4), CloudFront can serve a maintenance page from S3 on 502/503/504 |
| `AllowedMethods.ALLOW_GET_HEAD_OPTIONS` | CloudFront **rejects** POST/PUT/PATCH/DELETE on a behavior bound to an origin group; the demo is read-only so this is fine |
| `amazon-ssm-agent` sidecar + managed-instance role | Mandatory for `aws:ecs:task-*` — see below |
| `enableFaultInjection: true`, `pidMode: task` | Required by `aws:ecs:task-network-blackhole-port`; `pidMode: task` also forces an explicit `runtimePlatform` on Fargate |
| ECS Exec **disabled** | The AWS FIS user guide requires ECS Exec to be OFF for `aws:ecs:task-*` actions |
| ECS task targeting by `parameters: { cluster, service }` | The documented way to scope `aws:ecs:task`; a `cluster.clusterArn` **filter** resolves to an empty set and the experiment fails |
| 1 writer + 1 reader on Aurora | Minimum for `aws:rds:failover-db-cluster` to promote a reader |
| Single shared stop condition (ALB target 5xx ≥ 50/min) | A DB-connection-count alarm was removed: the nginx demo never opens a DB connection, so that alarm sat permanently in ALARM and FIS refused to start A-1 |

### The FIS SSM sidecar (A-3 / A-4)

The `aws:ecs:task-network-blackhole-port`, `-latency`, `-packet-loss`, `-cpu-stress`, `-io-stress`
and `-kill-process` actions **inject faults through an AWS Systems Manager (SSM) document**
(`AWSFIS-Run-Network-Blackhole-Port-ECS` for A-3/A-4). For SSM to reach a Fargate task, the task
must be **registered as an SSM managed instance**, and the only supported way to do that is a
dedicated sidecar container running the AWS-FIS registration script. From the AWS FIS user guide:

> *"To use `aws:ecs:task` actions, you will need to add a container with an SSM Agent to your
> Amazon ECS task definition … If you enabled Amazon ECS Exec, you must disable it before you
> can use these actions."*

What `app-stack.ts` sets up for this:

| Piece | Purpose |
| ----- | ------- |
| `amazon-ssm-agent` sidecar container (`public.ecr.aws/amazon-ssm-agent/amazon-ssm-agent:latest`, `essential: false`) | Runs the verbatim AWS-FIS script: `ssm create-activation` → `amazon-ssm-agent -register` → on `SIGTERM`, `delete-activation` + `deregister-managed-instance`. It tags the managed instance with `ECS_TASK_ARN` so FIS can map task → managed instance |
| `ssmManagedInstanceRole` (assumed by `ssm.amazonaws.com`) | `AmazonSSMManagedInstanceCore` + `ssm:DeleteActivation` + `ssm:DeregisterManagedInstance`. This is the role the registered managed instance assumes |
| Task role additions | `ssm:CreateActivation`, `ssm:AddTagsToResource`, and `iam:PassRole` **scoped to `ssmManagedInstanceRole`** |
| Task-def env `MANAGED_INSTANCE_ROLE_NAME` | Name of `ssmManagedInstanceRole`, read by the sidecar script |
| `enableFaultInjection: true` + `pidMode: task` on the task definition | Enables the ECS fault-injection endpoints; the network actions also need `useEcsFaultInjectionEndpoints: 'true'` in the action parameters |
| `enableExecuteCommand: false` on the service | ECS Exec must be off; its SSM agent process conflicts with the sidecar |
| FIS experiment role | `ecs:DescribeTasks`, `ssm:SendCommand`, `ssm:ListCommands`, `ssm:CancelCommand` |

Once running, `aws ssm describe-instance-information` shows two `mi-…` managed instances
(`Online`), one per task, and FIS `SendCommand` targets them via the `ECS_TASK_ARN` tag.

## Prerequisites

- AWS CLI v2 installed and configured
- Node.js 20 or later
- AWS CDK CLI (`npm install -g aws-cdk`)
- Basic knowledge of TypeScript and VPC networking
- AWS account with the FIS service-linked role (auto-created on first FIS use)

> **Cost note**: this architecture runs a NAT Gateway and two always-on Aurora Serverless v2
> ACUs — it costs roughly **$180–270 / month** if left running. Destroy the stacks after
> experiments. See [Cost Estimation](#cost-estimation).

## Project Directory Structure

```text
fis-arch-a-ecs-aurora/
├── bin/
│   └── fis-arch-a-ecs-aurora.ts              # App entry point (Stage instantiation)
├── lib/
│   ├── stages/
│   │   └── fis-chaos-stage.ts                # Stage: BaseStack → AppStack → FisStack
│   └── stacks/
│       ├── base-stack.ts                     # VPC + Aurora PostgreSQL Serverless v2 16.13
│       ├── app-stack.ts                      # ECS Fargate (+ SSM sidecar) + Internal ALB + CloudFront (VPC Origin)
│       └── fis-stack.ts                      # 4 FIS experiment templates + IAM + alarm
├── parameters/
│   ├── environments.ts                       # Environment parameter type
│   ├── dev-params.ts                         # Development environment parameters
│   └── index.ts                              # Parameter exports
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts                   # cdk-nag AwsSolutions compliance checks
│   └── snapshot/
│       └── snapshot.test.ts                  # CDK snapshot tests
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

```typescript
// parameters/dev-params.ts
const devParams: EnvParams = {
    region: 'ap-northeast-1',
    // alarmEmail: 'ops@example.com',
    // cloudfrontManagedPrefixList: 'pl-58a04531',  // ap-northeast-1 CloudFront prefix list
};
```

### 3. Bootstrap CDK (first time only)

```bash
PROJECT=<project> ENV=dev npm run bootstrap -w workspaces/fis-arch-a-ecs-aurora
```

### 4. Deploy all stacks

```bash
PROJECT=<project> ENV=dev npm run stage:deploy:all -w workspaces/fis-arch-a-ecs-aurora -- --require-approval never
```

Dependency order:
1. `<project>-dev-base` — VPC + Aurora cluster (~10 min; Aurora is the long pole)
2. `<project>-dev-app` — ECS Fargate + SSM sidecar + Internal ALB + CloudFront (~8 min; CloudFront distribution + VPC origin)
3. `<project>-dev-fis` — FIS templates + IAM + alarm (~1 min)

> This workspace shares some fixed resource names (the Aurora secret `…-aurora-secret`, the
> `…-fis-role` role) with **Architecture C**. Deploy only one of A / C into the same
> account + region at a time, or give one of them distinct names first.

### 5. Smoke-test the workload

```bash
CF=$(aws cloudformation describe-stacks --stack-name <project>-dev-app \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" --output text)
curl -s -o /dev/null -w '%{http_code}\n' "https://$CF/"     # → 200 (nginx welcome page)
```

### 6. Run a FIS experiment

**Console**: FIS → Experiment templates → pick `A-1`…`A-4` (`Scenario` tag) → **Start experiment**.

**CLI**:

```bash
aws fis list-experiment-templates \
  --query "experimentTemplates[?tags.Architecture=='CloudFront-ALB-ECS-Aurora'].{id:id,scenario:tags.Scenario}" \
  --output table

EXP=$(aws fis start-experiment --experiment-template-id <EXT...> --query "experiment.id" --output text)
watch -n5 "aws fis get-experiment --id $EXP --query 'experiment.{s:state.status,a:actions}'"
```

Useful side channels while an experiment runs:

```bash
# ECS self-healing (A-2 / A-4)
aws ecs describe-services --cluster <cluster> --services <svc> --query 'services[0].events[:8]'
# SSM document execution (A-3 / A-4)
aws ssm list-commands --query 'Commands[:3].{doc:DocumentName,status:Status,ok:CompletedCount,err:ErrorCount}'
# Real Aurora failover (A-1)
aws rds describe-events --duration 20 --query "Events[?contains(Message,'failover')]"
```

### Observed results (ap-northeast-1)

| Scenario | What happened | Notes |
| -------- | ------------- | ----- |
| **A-1** | `describe-events` shows *"Started / Completed cross AZ failover to … reader1"* within ~20 s. CloudFront stayed 200 throughout | The nginx demo holds no DB connection, so there is nothing to reconnect — swap in a real DB client to see pool-recovery behaviour |
| **A-2** | FIS stopped both tasks; ECS *"has started 2 tasks"* seconds later and reached steady state in ~45 s. CloudFront stayed 200 (origin-group fallback + fast replacement) | |
| **A-3** | SSM document `AWSFIS-Run-Network-Blackhole-Port-ECS` ran on both tasks (2/2 success). No workload impact — port 5432 egress only, and nginx never uses it | Confirms the sidecar + `useEcsFaultInjectionEndpoints` path works end-to-end |
| **A-4** | For ~75 s CloudFront returned `000` (connection failures) and briefly `404` from the S3 fallback origin, then recovered to 200 **while still running** as ECS replaced the unhealthy tasks with fresh (un-blackholed) ones | The recovery-by-replacement behaviour is itself a useful resilience finding |

The ALB-5xx stop condition (≥ 50/min) did not fire in any run.

## Testing

```bash
cd infrastructure
npm run test           -w workspaces/fis-arch-a-ecs-aurora
npm run test:snapshot  -w workspaces/fis-arch-a-ecs-aurora
npm run test:compliance -w workspaces/fis-arch-a-ecs-aurora
npm run test:snapshot:update -w workspaces/fis-arch-a-ecs-aurora   # after intentional changes
```

| Test suite | File | Assertions |
| ---------- | ---- | ---------- |
| Snapshot | `test/snapshot/snapshot.test.ts` | Full CFn snapshots for all 3 stacks; Aurora writer+reader; task def has the SSM sidecar + `EnableFaultInjection` + `PidMode: task`; ALB is internal; exactly 4 FIS templates; every template has a stop condition |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutions pack — no unsuppressed findings |

## Cost Estimation

Pricing is **on-demand list price, September 2026** (retrieved via the AWS Price List API),
excluding the AWS Free Tier. Regions: **US East (N. Virginia) `us-east-1`** and
**Asia Pacific (Tokyo) `ap-northeast-1`**.

### Idle / steady-state (per month, ~730 h, no traffic)

| Service | Basis | us-east-1 | ap-northeast-1 |
| ------- | ----- | --------- | -------------- |
| Aurora Serverless v2 | 2 instances × 0.5 ACU floor × 730 h × ($0.12 / $0.15 per ACU-h) | ~$87.60 | ~$109.50 |
| NAT Gateway (×1) | 730 h × ($0.045 / $0.062 per h) + minimal data | ~$33 | ~$46 |
| ECS Fargate | 2 tasks × (0.5 vCPU + 1 GB) × 730 h; vCPU $0.04048 / $0.05056, GB $0.004445 / $0.005530 | ~$36 | ~$45 |
| ALB | 730 h × ($0.0225 / $0.0243 per h) + ~1 LCU × $0.008 | ~$22 | ~$24 |
| Secrets Manager | 1 secret × $0.40 | $0.40 | $0.40 |
| Aurora storage / CloudWatch alarm / logs | a few GB + 1 alarm ($0.10) | ~$1 | ~$1 |
| **Total (running 24×7)** | | **≈ $180 / month** | **≈ $270 / month** |

### One test cycle (deploy → run all 4 experiments → destroy, ~1.5–2 h of runtime)

| Service | Usage assumption | us-east-1 | ap-northeast-1 |
| ------- | ---------------- | --------- | -------------- |
| **FIS** | A-1 + A-2 short, A-3 + A-4 = PT5M each → **≈ 12–16 action-minutes** @ $0.10 | **~$1.20–1.60** | **~$1.20–1.60** |
| Aurora Serverless v2 | ~2 h × 2 × 0.5 ACU (brief spike during failover) | ~$0.30 | ~$0.35 |
| NAT + Fargate + ALB | ~2 h of the idle rates above | ~$0.40 | ~$0.50 |
| Secrets Manager / CloudWatch | prorated | <$0.05 | <$0.05 |
| **Total per cycle** | | **≈ $2** | **≈ $2.5** |

**Correction vs. earlier versions of this doc:** FIS is **not free**. It bills **$0.10 per
action-minute** (same in both regions). The steady-state figure was also understated — two
always-on Aurora ACUs plus a NAT Gateway dominate at ~$180 (us-east-1) / ~$270 (Tokyo) per month.

## Security Considerations

- **ALB is internal** — not internet-facing; CloudFront VPC Origin is the only path in.
- **FIS experiment role — least privilege**: `rds:FailoverDBCluster` on the Aurora ARN; `ecs:StopTask`/`DescribeTasks`/`ListTasks` scoped to the cluster; `ssm:SendCommand`/`ListCommands`/`CancelCommand` for the ECS task actions; `cloudwatch:DescribeAlarms` on the one stop-condition alarm; CloudWatch Logs delivery actions.
- **SSM managed-instance role — least privilege**: `AmazonSSMManagedInstanceCore` plus only `ssm:DeleteActivation` / `ssm:DeregisterManagedInstance` (self-deregistration on shutdown). The task role's `iam:PassRole` is scoped to this role's ARN.
- **ECS Exec disabled** — removes the `ssmmessages:*` surface entirely; the sidecar is the only SSM path and it self-deregisters on `SIGTERM`.
- **Stop condition is mandatory** — every template carries the ALB-5xx alarm stop condition.

## Clean-up

```bash
PROJECT=<project> ENV=dev npm run stage:destroy:all -w workspaces/fis-arch-a-ecs-aurora -- --force
```

All resources use `removalPolicy: DESTROY`. If a rollback ever leaves the `ErrorPageBucket`
non-empty, empty it (`aws s3 rm s3://<bucket> --recursive`) and re-run destroy. The Aurora
secret is retained with a recovery window unless force-deleted
(`aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery`).

## Summary

FIS chaos engineering on a container three-tier web stack:

- **A-1** — Aurora writer→reader failover: does the app reconnect?
- **A-2** — stop every ECS task: does ALB drain and ECS self-heal fast enough?
- **A-3** — sever the DB egress path: are query timeouts and circuit breakers correct?
- **A-4** — sever ingress to the tasks: does ALB detect unhealthy hosts and does CloudFront fall back?

The heavy lift is A-3/A-4: `aws:ecs:task-*` needs a purpose-built SSM sidecar, `enableFaultInjection`,
`pidMode: task` and ECS Exec **off**. Running the stack costs ~$180–270/month; a full
four-experiment test cycle costs about **$2**, dominated by FIS action-minutes.

## References

- [AWS FIS — Actions reference](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [Use the AWS FIS `aws:ecs:task` actions (SSM sidecar setup)](https://docs.aws.amazon.com/fis/latest/userguide/ecs-task-actions.html)
- [AWS FIS — Targets (resource parameters, filters)](https://docs.aws.amazon.com/fis/latest/userguide/targets.html)
- [AWS FIS pricing](https://aws.amazon.com/fis/pricing/)
- [CDK `aws-fis` module (L1 constructs)](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_fis-readme.html)
- [CloudFront VPC Origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html)
