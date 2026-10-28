*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

# ECS Capacity Provider Strategy: FARGATE Base + FARGATE_SPOT Weight with AZ Rebalancing - AWS CDK Reference Architecture

![Level 300](https://img.shields.io/badge/Level-300-orange)
![AWS CDK](https://img.shields.io/badge/AWS%20CDK-2.273-blue)
![Amazon ECS](https://img.shields.io/badge/Amazon%20ECS-Fargate%20Spot-FF9900)

Fargate Spot runs the same tasks on spare capacity for up to 70% less, but AWS can take the capacity back with a two-minute warning, and when Spot capacity runs out **Fargate does not fall back to on-demand**. A capacity provider strategy lets one service use both: a `base` of tasks that always run on `FARGATE`, and a `weight` that sends most of the remaining tasks to `FARGATE_SPOT`.

This architecture builds that service with CDK, spreads it over three AZs with **AZ rebalancing set explicitly**, drains every task on SIGTERM inside the Spot warning, records Spot interruptions with EventBridge, and deploy-verifies the behavior in ap-northeast-1: placement per AZ and capacity provider, a task stop under load with zero failed requests, the real default of AZ rebalancing, and recovery of the AZ balance after a simulated AZ impairment.

![Architecture](./overview.drawio.svg)

## 📑 Table of Contents

- [Architecture Overview](#️-architecture-overview)
- [Design Decisions and Best Practices](#-design-decisions-and-best-practices)
- [Verification Results](#-verification-results-deployed-to-ap-northeast-1)
- [Well-Architected Alignment](#️-well-architected-alignment)
- [Cost](#-cost)
- [Security Considerations](#-security-considerations)
- [Prerequisites](#-prerequisites)
- [Deployment](#-deployment)
- [Usage (test-spot.sh)](#usage-test-spotsh)
- [Testing Strategy](#-testing-strategy)
- [Customization](#️-customization)
- [Troubleshooting](#-troubleshooting)
- [Cleanup](#-cleanup)
- [References](#-references)

## 🏗️ Architecture Overview

### Key Components

| Component | Configuration | Why |
| --- | --- | --- |
| VPC | 3 AZs, public + private `/24` subnets, 1 NAT gateway (dev), flow logs (REJECT) | Three AZs give the scheduler and the rebalancer room to spread 6 tasks 2/2/2 |
| ECS cluster | `enableFargateCapacityProviders`, Container Insights (enhanced) | Registers `FARGATE` and `FARGATE_SPOT` so a service can name them in its strategy |
| ECS service | Strategy `FARGATE base 2, weight 1` + `FARGATE_SPOT weight 3`, desired 6 | 2 tasks are guaranteed on-demand; the other 4 are split 1:3 → 3 FARGATE + 3 FARGATE_SPOT |
| AZ rebalancing | `availabilityZoneRebalancing: ENABLED`, `maxHealthyPercent: 200` | Moves tasks back to an AZ after it recovers; needs room above 100% to start a task before stopping one |
| Task definition | x86_64, 0.25 vCPU / 0.5 GB, `stopTimeout: 120`, read-only root FS | Fargate Spot does not run ARM64; 120 s is the length of the Spot warning |
| Application | `src/app.py` (Python standard library) | Answers with its task ID and AZ; on SIGTERM reports unhealthy, keeps serving for 15 s, then exits |
| ALB | Public subnets in 3 AZs, port 80 from `ALLOWED_IPS` only, access logs to S3, deregistration delay 30 s, `/health` | Deregistration finishes well inside the 2-minute Spot warning |
| Auto Scaling | Target tracking on CPU 60%, 6–12 tasks | Scale-out follows the same strategy (base first, then weight) |
| EventBridge → CloudWatch Logs | `spot-interruptions` (stop code `TerminationNotice`), `task-stopped`, `service-actions` | Interruptions, rebalancing and placement failures can be counted after the fact |
| `test-spot.sh` | `status` / `traffic` / `drain` / `rebalance` / `events` | Shows what the strategy and the rebalancer actually did |

### Stack

One stack, `<project>-<env>-ecs-fargate-spot`, built from three constructs:

- `lib/constructs/web-alb.ts`: security group, access log bucket, ALB, HTTP listener
- `lib/constructs/mixed-capacity-service.ts`: parameter validation, task definition, service with the strategy, target group, scaling
- `lib/constructs/task-event-recorder.ts`: three EventBridge rules and their log groups

## 🎯 Design Decisions and Best Practices

### 1. `base` on FARGATE, `weight` towards FARGATE_SPOT

```typescript
capacityProviderStrategies: [
  { capacityProvider: 'FARGATE', base: 2, weight: 1 },
  { capacityProvider: 'FARGATE_SPOT', weight: 3 },
],
```

`base` is placed first and only one provider may have one. The rest is split by weight, so with 6 tasks: 2 (base) + 4 × 1/4 = 3 on FARGATE, 4 × 3/4 = 3 on FARGATE_SPOT. Scaled to 9 the service ran 4 FARGATE + 5 FARGATE_SPOT (7 weighted tasks → 1.75 / 5.25, rounded to 2 / 5). `splitByStrategy()` computes the split, and the stack warns at synth time when a provider's count is not a multiple of the AZ count: ECS spreads each provider on its own ("the spread behavior is independent for each capacity provider"), so such counts cannot be even per AZ for both providers.

The base is the floor the service keeps when Spot capacity disappears: "Fargate doesn't replace Spot capacity with on-demand capacity" (ECS developer guide). Size it for the minimum traffic you must serve, not for the average.

| Environment | Suggested strategy | Reason |
| --- | --- | --- |
| dev / test | `FARGATE_SPOT weight 1` (no base) | Interruptions are acceptable; maximum discount |
| stg | `FARGATE base 1` + `FARGATE_SPOT weight 3` | Production-like mix at lower cost |
| prd | `FARGATE base N` + `FARGATE weight 1` + `FARGATE_SPOT weight 1–3` | `N` covers the minimum load; the weight decides how much of the peak may be interrupted |

#### Smallest strategies that keep two AZs

Because each provider is spread on its own, `FARGATE 1 + FARGATE_SPOT 1` can land both tasks in one AZ and neither provider looks unbalanced. Costs: 0.25 vCPU / 0.5 GB, ap-northeast-1, Spot at 70% off.

| Tasks | Normal | Spot capacity gone | Monthly |
| --- | --- | --- | --- |
| `FARGATE_SPOT` × 2 | 2 AZs (the two Spot tasks are spread) | 0 tasks | ~$6.7 |
| `FARGATE` 1 + `FARGATE_SPOT` 1 | not guaranteed (may share an AZ) | 1 task, 1 AZ | ~$14.6 |
| `FARGATE` 1 + `FARGATE_SPOT` 2 | 2+ AZs (Spot alone covers two) | 1 task, 1 AZ | ~$18.0 |
| `FARGATE` 2 | 2 AZs | 2 AZs | ~$22.5 |

- dev: `FARGATE_SPOT` × 2 is AZ-redundant while Spot is available.
- Cheapest "two AZs normally, never zero tasks": `FARGATE base 1` + `FARGATE_SPOT` with desired 3.
- "Two AZs even without Spot": `FARGATE base 2`.

#### Scale on Spot first, add on-demand every N tasks

Measured on ECS (desired 3 → 14, one step at a time, `FARGATE base 1, weight 1` + `FARGATE_SPOT weight k`):

| Desired | 3 | 4 | 5 | 6 | 7 | 8–11 | 12 | 13 | 14 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `1:6` on-demand / Spot | 1/2 | 1/3 | **2**/3 | 2/4 | 2/5 | 2/6–9 | **3**/9 | 3/10 | 3/11 |
| `1:11` on-demand / Spot | 1/2 | 1/3 | 1/4 | 1/5 | **2**/5 | 2/6–9 | 2/10 | 2/11 | 2/12 |
| `1:3` on-demand / Spot | **2**/1 | 2/2 | 2/3 | 2/4 | | | | | |

The split follows `on-demand = base + round((desired − base) / (k + 1))`, with a tie going to `FARGATE` (`splitByStrategy()` reproduces all 24 measured points). So with `base B` and `1:k`:

- the first extra on-demand task comes at `desired = B + ceil((k + 1) / 2)`, then one more every `k + 1` tasks;
- `1+2 → 1+3 → 2+3` (3 → 4 → 5 tasks) is `1:6`; `1:3` already gives 2 on-demand at 3 tasks;
- the share of Spot at the top of the range approaches `k / (k + 1)` (1:6 ≈ 86%, 1:11 ≈ 92%).

Weights are proportional, so "Spot only up to 20 tasks, then on-demand" cannot be expressed. For a hard threshold, keep `FARGATE weight 0` (on-demand stays at `base`, all scaling on Spot) and raise `base` by changing the parameter, or run a second on-demand service.

The strategy lives in `parameters/<env>-params.ts`, so each environment chooses its own mix without code changes. `validateServiceParams()` rejects at synth time: a duplicated provider, a base on two providers, no positive weight, `stopTimeout > 120`, `drainSeconds >= stopTimeout`, a deregistration delay of 120 s or more, AZ rebalancing with `maxHealthyPercent <= 100`, and a desired count outside the scaling range.

### 2. AZ rebalancing: set it explicitly

AZ rebalancing (November 2024) moves tasks back into an AZ that has fewer tasks than the others, for example after an AZ impairment. The rebalancing guide states that "starting September 5, 2025, Amazon ECS enables Availability Zone rebalancing for all services that are eligible" (AZ spread first or no placement strategy), and the API reference says an unspecified value becomes `ENABLED` on create, while the service definition parameter page still says `DISABLED`. Measured with `CreateService` without the parameter (see verification 2):

- New service → `ENABLED`
- New service with `maximumPercent: 100` → **`DISABLED`, silently** (rebalancing needs to start a task before stopping one)
- `UpdateService` without the parameter keeps the current value. A service created when the default was `DISABLED` stays `DISABLED`.

CDK omits the property when it is not set, so `cdk deploy` gives you whatever the service default is at creation time. This architecture sets `ENABLED` and validates `maxHealthyPercent > 100`. It also does not use placement constraints on `attribute:ecs.availability-zone` or a Classic Load Balancer, both of which disable rebalancing.

Two measured limits shape the rest of the design (verification 4): rebalancing starts about **15 minutes** after the service reaches a steady state, and with a mixed strategy it works **per capacity provider**, so a total of 4/2/3 made of two balanced providers is never corrected. Hence the 6 = 3 + 3 split over 3 AZs and the synth-time warning when a provider's count is not a multiple of the AZ count.

### 3. Drain inside the two-minute Spot warning

On a Spot interruption the task receives SIGTERM and an `ECS Task State Change` event with stop code `TerminationNotice`; after `stopTimeout` (max 120 s) it gets SIGKILL. The time budget:

```
deregistration delay (30 s) + application drain (15 s)  <  stopTimeout (120 s) = Spot warning (120 s)
```

The application turns `/health` to 503 on SIGTERM, keeps answering in-flight and late requests for `DRAIN_SECONDS`, then exits with code 0. The ALB's default deregistration delay (300 s) would outlive the warning, so it is set to 30 s.

### 4. Record interruptions, not only react to them

Three EventBridge rules write to CloudWatch Logs under `/aws/events/<prefix>/`:

| Log group | Pattern | Answers |
| --- | --- | --- |
| `spot-interruptions` | `ECS Task State Change`, `stopCode: TerminationNotice` | How often is Spot reclaimed, in which AZ |
| `task-stopped` | `lastStatus: STOPPED` | Why every task stopped: e.g. `Availability-zone rebalancing initiated by (deployment ...)`, `Scaling activity initiated by ...`, `TaskFailedToStart` with the EC2 error |
| `service-actions` | `ECS Service Action` | Placement failures such as `SERVICE_TASK_PLACEMENT_FAILURE` / `SERVICE_TASK_CONFIGURATION_FAILURE` |

### 5. x86_64 only

Fargate Spot does not run ARM64 tasks, so the task definition pins `X86_64`. If you want Graviton for the on-demand part, use a separate service (strategy is per service, the task definition is shared by both providers).

### 6. Private tasks, NAT for egress

Tasks have no public IP and accept port 8080 from the ALB security group only. They pull the public Python image through one NAT gateway in dev. In production use one NAT gateway per AZ (otherwise an AZ failure of the NAT takes egress away from the healthy AZs) or VPC endpoints with a private ECR image.

## 🔬 Verification Results (deployed to ap-northeast-1)

Deployed with `cdk deploy` to account `drillexercises-dev` on 2026-10-28 (aws-cdk-lib 2.273.0). The stack was destroyed afterwards.

### 1. Placement by strategy and AZ

`./test-spot.sh status` after the first deploy (279 s):

```
AZ               FARGATE  FARGATE_SPOT  total
ap-northeast-1a  1        1             2
ap-northeast-1c  1        1             2
ap-northeast-1d  1        1             2
total            3        3             6
```

The base/weight math held (3 + 3), and the AZ spread applied to each provider as well: every AZ got one task of each. `test-spot.sh traffic` with 60 requests: 21 / 19 / 20 answers per AZ, 9–11 per task.

### 2. The real default of AZ rebalancing

`aws ecs create-service` without `--availability-zone-rebalancing` on this cluster:

| Service | Result |
| --- | --- |
| Launch type `FARGATE` | `ENABLED` |
| Strategy `FARGATE_SPOT weight 1` | `ENABLED` |
| Launch type `FARGATE`, `maximumPercent=100` | `DISABLED` (no error) |
| `update-service` without the parameter on the first one | stays `ENABLED` |

### 3. A task stop under load

`./test-spot.sh drain` stopped a FARGATE_SPOT task with `StopTask` while sending ~4 requests/s:

| Elapsed | Event |
| --- | --- |
| +0.7 s | task `DEACTIVATING` (target still healthy) |
| +8.1 s | target `draining` |
| +38.1 s | target removed (30 s deregistration delay) |
| +54.1 s | task `STOPPING` |
| +54.9 s | application logs **SIGTERM** |
| +69.9 s | application exits (15 s drain) |
| +104.8 s | task `STOPPED` |
| — | **553 requests, all HTTP 200** |

For a stop the scheduler initiates (StopTask, scale-in, deployment, rebalancing), ECS deregisters the target and waits for the deregistration delay **before** it sends SIGTERM. A Spot interruption sends SIGTERM together with the two-minute warning, so the drain in the application is what protects requests in that case; that path cannot be triggered on demand and was not reproduced.

### 4. AZ impairment and rebalancing

An AZ impairment was simulated by occupying every free IP of the 1c private subnet with temporary ENIs (49 secondary IPs each, 5 ENIs for the `/24`).

**Stopping the tasks of the AZ does not empty it.** A stopping task keeps its IP through the deregistration delay and `stopTimeout`. The replacements (started at once thanks to 200%) tried 1c 18 times about every 9 seconds (`TaskFailedToStart: ... InsufficientFreeAddressesInSubnet`) and then took the IPs the old tasks released, back in 1c.

**Scaling out goes around it.** With 1c full, 6 → 9 placed the new tasks in 1a and 1d within 52–71 s (two runs):

```
AZ               FARGATE  FARGATE_SPOT  total
ap-northeast-1a  2        2             4
ap-northeast-1c  1        1             2
ap-northeast-1d  1        2             3
```

**4/2/3 is not rebalanced.** After the IPs were released, nothing moved for 30 minutes (two runs). ECS spreads each capacity provider on its own, and each one is within range here (FARGATE 4 → 2/1/1, SPOT 5 → 2/1/2), even though the total is uneven.

**Scaling back in creates an imbalance that is rebalanced.** Going from 9 to 6 stopped tasks in the AZ with the most tasks in total (1a), leaving 1a=1 / 1c=2 / 1d=3 with SPOT at 0/1/2 (same result in both runs from 4/2/3; a third run that started from 3/2/4 scaled in straight to 2/2/2). The service events:

| Time (UTC) | Service event |
| --- | --- |
| 14:24:19 | `has reached a steady state.` |
| 14:39:26 | `is not AZ balanced with 1 tasks in ap-northeast-1a, 2 tasks in ap-northeast-1c, 3 tasks in ap-northeast-1d. AZ Rebalancing in progress.` |
| 14:39:26 | `has started 1 tasks in ap-northeast-1a to AZ Rebalance` (FARGATE_SPOT) |
| 14:40:43 | `has stopped 1 running tasks` (FARGATE_SPOT in 1d, after the new task was healthy) |
| 14:40:52 | `is AZ balanced with 2 tasks in ap-northeast-1a, 2 tasks in ap-northeast-1c, 2 tasks in ap-northeast-1d.` |

The second run took 15 min 27 s from the steady state to the start and 88 s to finish (first run: 15 min 07 s and 86 s). **AZ rebalancing is not immediate: plan for about 15 minutes of imbalance after an event.**

**Control: a new service does not route around a full AZ either.** A launch-type `FARGATE` service (no strategy) created while 1c was full stayed at 4 of 6 tasks (2 + 2) for 20 minutes; the scheduler retried 1c with growing gaps (10 s, then ~5 min) instead of placing the tasks elsewhere, and placed them 183 s after the IPs were released.

What this means for the design:

- Keep each provider's task count a multiple of the AZ count (6 = 3 + 3 over 3 AZs). Otherwise the total per AZ can stay uneven with rebalancing enabled; the stack warns at synth time (`fgspot:uneven-az-split`).
- Size the base and the per-AZ capacity for running about 15 minutes on the remaining AZs.
- Leave free IPs in every subnet: a full subnet is retried, not avoided.

### 5. Teardown

The first `cdk destroy` failed: CloudFormation deleted the `AWS::ECS::ClusterCapacityProviderAssociations` in parallel with the service and got `The specified capacity provider is in use and cannot be removed`, because the service did not depend on the association. `MixedCapacityService` now adds `service.node.addDependency(cluster)` (unit-tested), and a fresh deploy (298 s) and destroy (310 s) completed in one pass. ECS leaves the Container Insights log group `/aws/ecs/containerinsights/<cluster>/performance`; delete it by hand.

## 🏛️ Well-Architected Alignment

| Pillar | How this architecture addresses it |
| --- | --- |
| Operational Excellence | Strategy per environment in parameters; synth-time validation; `test-spot.sh` shows placement, drain and rebalancing; EventBridge records interruptions, stops and placement failures |
| Security | ALB open to `ALLOWED_IPS` only; tasks in private subnets reachable only from the ALB group; read-only root filesystem; ALB drops invalid headers; access logs; flow logs for rejected traffic |
| Reliability | On-demand `base` survives Spot shortages; tasks spread over 3 AZs and rebalanced after impairments; SIGTERM drain inside the Spot warning; deployment circuit breaker with rollback |
| Performance Efficiency | Target tracking scaling 6–12 tasks; the strategy applies to scale-out as well |
| Cost Optimization | 3 of 6 tasks on Fargate Spot: ~35% less compute than all on-demand (dev); 1 NAT gateway in dev |
| Sustainability | Spot uses capacity that would otherwise be idle; small task sizes |

## 💰 Cost

ap-northeast-1, 730 hours/month. Fargate on-demand list price $0.05056 per vCPU-hour and $0.00553 per GB-hour (Pricing API, 2026-10-28). Fargate Spot prices change with supply; the table assumes the advertised "up to 70%" discount.

| Item | Calculation | Monthly (USD) |
| --- | --- | --- |
| Fargate on-demand × 3 | 3 × (0.25 × 0.05056 + 0.5 × 0.00553) × 730 | ~33.7 |
| Fargate Spot × 3 | 3 × 0.015405 × 0.3 × 730 | ~10.1 |
| ALB | $0.0243/h × 730 + ~1 LCU | ~23.6 |
| NAT gateway | $0.062/h × 730 + data | ~45.3 |
| Public IPv4 (ALB in 3 AZs + NAT) | 4 × $0.005/h × 730 | ~14.6 |
| CloudWatch Logs, Container Insights (enhanced), S3 | small | ~5 |
| **Total (dev)** | | **~132** |

Compute comparison for the same 6 tasks:

| Strategy | Monthly compute (USD) | vs. all on-demand |
| --- | --- | --- |
| All `FARGATE` | 67.5 | — |
| `FARGATE base 2 w1` + `FARGATE_SPOT w3` (this stack) | 43.9 | −35% |
| `FARGATE base 2` + `FARGATE_SPOT w1` only above the base | 35.1 | −48% |
| All `FARGATE_SPOT` | 20.2 | −70% |

The saving grows with the size of the service while the base stays fixed: at 20 tasks with `base 2`, 16.5 of 20 tasks are on Spot (−58%).

Production: one NAT gateway per AZ (+$90) or VPC endpoints, and a base that covers the minimum load.

## 🔒 Security Considerations

- **Ingress**: the ALB security group allows port 80 from `ALLOWED_IPS` (default: the deploying machine's IP). For production add HTTPS with ACM and AWS WAF.
- **Tasks**: no public IP; only the ALB security group reaches port 8080; root filesystem is read-only; the image is the official Python image from Amazon ECR Public.
- **IAM**: the execution role only pulls the image and writes its log group; the task has no task role (it calls no AWS API).
- **Logs**: ALB access logs (S3, SSE-S3, TLS-only bucket policy, 30-day lifecycle), flow logs for rejected traffic, application and event logs with 7-day retention in dev.
- **Spot interruption data** contains task ARNs and AZs only.

CDK Nag suppressions (all in `test/compliance/cdk-nag.test.ts`): IAM4 and L1 (CDK-provided custom resource handlers), IAM5 (execution role log-stream wildcard), S1 (the access log bucket itself), ECS2 (environment variables are the port and the drain duration).

## 📋 Prerequisites

- Node.js 24, AWS CDK CLI, a bootstrapped account
- AWS CLI v2, `jq`, `curl` for `test-spot.sh`

## 🚀 Deployment

```bash
cd infrastructure/workspaces/ecs-fargate-spot-capacity-provider

# Client IPs allowed on the ALB (defaults to this machine's global IP)
export ALLOWED_IPS=203.0.113.10

PROJECT=myproject ENV=dev npm run stage:deploy:all -- --require-approval never
```

The first deploy takes about 5 minutes.

## Usage (test-spot.sh)

```bash
./test-spot.sh --project myproject --env dev status     # strategy, AZ rebalancing, tasks per AZ x provider
./test-spot.sh --project myproject --env dev traffic    # answers per AZ and task through the ALB
./test-spot.sh --project myproject --env dev drain      # stop one Spot task under load, follow target/SIGTERM/errors
./test-spot.sh --project myproject --env dev rebalance  # simulate an AZ impairment and time the rebalancing
./test-spot.sh --project myproject --env dev events     # recorded stops, Spot interruptions, service actions
```

`rebalance` (about 20 minutes) fills every free IP of one AZ's private subnet with temporary ENIs, scales the service out by 3, releases the IPs, scales back in, and waits until every capacity provider is balanced, printing the AZ × provider matrix at each step. It restores the desired count and the scaling minimum and deletes the ENIs on exit (also on Ctrl-C).

## 🧪 Testing Strategy

```bash
npm test -w workspaces/ecs-fargate-spot-capacity-provider
```

| Suite | Covers |
| --- | --- |
| `test/unit/stack.test.ts` | 3-AZ VPC and flow logs; cluster capacity providers and Container Insights; strategy (and an all-Spot variant), service `DependsOn` the capacity provider association, no launch type; `AvailabilityZoneRebalancing` (and `DISABLED` variant), 100/200%, circuit breaker, private subnets; `StopTimeout 120`, `DRAIN_SECONDS`, deregistration delay and `/health`, x86_64, read-only root FS; scaling; ALB ingress (IPv4/IPv6), task ingress from the ALB only, access logs; EventBridge rules and log groups; every `validateServiceParams` rule; `splitByStrategy` and the `fgspot:uneven-az-split` warning |
| `test/snapshot/snapshot.test.ts` | Full template and resource counts |
| `test/compliance/cdk-nag.test.ts` | AwsSolutions pack with documented suppressions |

## ⚙️ Customization

| Parameter (`parameters/dev-params.ts`) | Effect |
| --- | --- |
| `service.capacityProviderStrategies` | Base and weights per provider |
| `service.desiredCount` / `autoScaling.*` | Task count and scaling range / CPU target |
| `service.availabilityZoneRebalancing` | `ENABLED` / `DISABLED` |
| `service.minHealthyPercent` / `maxHealthyPercent` | Deployment and rebalancing headroom (`max` must stay above 100 with rebalancing) |
| `service.stopTimeoutSeconds` / `drainSeconds` / `deregistrationDelaySeconds` | SIGTERM-to-SIGKILL time, application drain, ALB drain |
| `service.cpu` / `memoryLimitMiB` | Task size (x86_64) |
| `network.maxAzs` / `natGateways` | AZ count / NAT gateways |
| `containerImage` | Any image with Python 3 (the app is passed as `python -c`) |

## 🔧 Troubleshooting

| Symptom | Cause / action |
| --- | --- |
| Fewer RUNNING tasks than desired, Spot tasks stay `PROVISIONING` / service events "unable to place a task" | Spot capacity is short. Fargate does not fall back to on-demand; the base keeps running. Check `test-spot.sh events` (service actions) and consider a larger base or a `FARGATE` weight |
| `describe-services` shows `availabilityZoneRebalancing: DISABLED` although you did not set it | Service created when the default was `DISABLED`, or `maximumPercent` is 100. Set `ENABLED` explicitly with `maxHealthyPercent > 100` |
| Tasks stay unbalanced after an AZ recovers | Rebalancing starts ~15 min after the steady state; wait for `is not AZ balanced` in the service events. If it never comes: each capacity provider may be balanced on its own (see verification 4 and the `fgspot:uneven-az-split` warning), rebalancing is disabled, or a placement constraint on `attribute:ecs.availability-zone` / a first placement strategy other than AZ spread is set |
| `TaskFailedToStart: InsufficientFreeAddressesInSubnet` | The AZ's subnet has no free IP. Replacements and a new service keep retrying that AZ with backoff (up to ~5 minutes apart) instead of moving (see verification 4); free IPs or use larger subnets |
| 5xx during deployments or scale-in | Deregistration delay longer than the drain, or the application exits immediately on SIGTERM |
| `cdk deploy` fails with `stopTimeoutSeconds must be 120 or less` (or another validation message) | `validateServiceParams()` rejected the parameters; the message names the rule |
| `cdk destroy` fails on `ClusterCapacityProviderAssociations`: `The specified capacity provider is in use` | A service with a capacity provider strategy does not depend on the association. Add `service.node.addDependency(cluster)`; for a stack already in `DELETE_FAILED`, delete it again once the service is gone |

First step for any symptom: `./test-spot.sh --project <p> --env <e> status` and `events`.

## 🧹 Cleanup

```bash
PROJECT=myproject ENV=dev npm run stage:destroy:all

# Container Insights log group created by ECS (not part of the stack)
aws logs delete-log-group --log-group-name /aws/ecs/containerinsights/myproject-dev-fgspot/performance
```

## 📚 References

- [Amazon ECS clusters for Fargate (capacity providers, Spot termination notices)](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-capacity-providers.html)
- [Balancing an Amazon ECS service across Availability Zones](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-rebalancing.html)
- [AWS::ECS::Service AvailabilityZoneRebalancing](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ecs-service.html)
- [Deep dive into Fargate Spot to run your ECS Tasks for up to 70% less (AWS Compute Blog)](https://aws.amazon.com/blogs/compute/deep-dive-into-fargate-spot-to-run-your-ecs-tasks-for-up-to-70-less/)
- [Graceful shutdowns with ECS (AWS Containers Blog)](https://aws.amazon.com/blogs/containers/graceful-shutdowns-with-ecs/)
- [How do I use Fargate Spot capacity providers for Amazon ECS? (re:Post)](https://repost.aws/knowledge-center/ecs-fargate-spot-capacity-provider)
- Knowledge base: [docs/knowledge/ecs-fargate-spot-capacity-provider.md](../../../docs/knowledge/ecs-fargate-spot-capacity-provider.md)

---

**Level 300** · Part of [AWS CDK Reference Architectures](../../../README.md)
