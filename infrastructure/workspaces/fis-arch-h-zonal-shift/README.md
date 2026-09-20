# FIS Chaos Engineering — Architecture H: ARC Zonal Shift on Auto Scaling

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20ARC%20%7C%20NLB%20%7C%20EC2%20ASG%20%7C%20Aurora-orange?style=flat-square)

## Introduction

This project is a direct follow-up to [Architecture G](../fis-arch-g-multiaz-network). G's G-2 scenario (`aws:network:disrupt-connectivity`, `scope: all`, isolating one Availability Zone's network) deploy-verified a real limitation of Amazon EC2 Auto Scaling's default self-healing: when a network partition makes an instance fail its target-group health check, Auto Scaling can't tell that apart from the instance actually being broken, and its AZ-avoidance logic only engages on a **launch failure** — not a post-launch health-check failure. The result observed in G-2: the replacement instance landed right back in the still-partitioned AZ.

This workspace deploys the same NLB → EC2 Auto Scaling Group (2 AZs) → Aurora PostgreSQL Multi-AZ base as Architecture G, but with the ASG registered for **[Auto Scaling group zonal shift](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-zonal-shift.html)** — a capability of Amazon Application Recovery Controller (ARC) — and deploy-verifies whether an operator-triggered zonal shift actually changes the outcome G-2 exposed.

📁 **Code repository**: [fis-arch-h-zonal-shift](https://github.com/ishiharatma/aws-cdk-reference-architectures/tree/main/infrastructure/workspaces/fis-arch-h-zonal-shift)

### What you'll learn in this workspace

- How to register an Auto Scaling group with ARC zonal shift via CDK (`AvailabilityZoneImpairmentPolicy` — not yet on the L2 `AutoScalingGroup` construct, so this uses the L1 escape hatch)
- The precise mechanics of `ReplaceUnhealthy` vs `IgnoreUnhealthy`, and why only a launch-time failure (not a health-check failure) normally makes Auto Scaling avoid a bad AZ on its own
- How to start, verify, and end a zonal shift against an ASG with the AWS CLI, and observe its effect on the exact fault Architecture G's G-2 already deploy-verified

## Architecture Overview

```
Internet ──► NLB (internet-facing, 2 AZs) ──► EC2 ASG (nginx, 2 AZs, zonal-shift-enabled) ──► Aurora PostgreSQL Multi-AZ
```

| Component | Role |
| --------- | ---- |
| NLB | Internet-facing, cross-zone load balancing enabled — same as Architecture G |
| EC2 Auto Scaling Group | `minCapacity=2`, `maxCapacity=4`; `AvailabilityZoneImpairmentPolicy.ZonalShiftEnabled: true`; `InstanceMaintenancePolicy` (100/150%) so a replacement is ready before the old instance is terminated |
| Aurora PostgreSQL Serverless v2 | 1 writer + 1 reader, Multi-AZ — kept for parity with Architecture G's base; not an FIS target here |
| AWS FIS | One experiment template (H-1) — the identical fault Architecture G's G-2 uses |
| ARC zonal shift | **Not** provisioned by CDK — a runtime, operator-triggered action against the already-deployed ASG (see [Deployment Guide](#deployment-guide)) |

| Scenario | Fault Injected | Duration | What It Validates |
| -------- | --------------- | -------- | ------------------ |
| **H-1** (no active shift) | `aws:network:disrupt-connectivity`, `scope: all`, AZ-1 subnet | 5 min | Control: reproduces Architecture G's G-2 result exactly |
| **H-1** (with an active zonal shift on AZ-1) | Same fault, same template | 5 min | Whether Auto Scaling actually launches the replacement in AZ-2 instead |

## Why this isn't just "G again"

Architecture G already deploy-verified the *problem*. This workspace is not a second copy of that fault — it is a test of whether a documented AWS *response* mechanism changes the outcome. The FIS experiment template here is deliberately identical to G-2's; the only variable under test is whether `AvailabilityZoneImpairmentPolicy` plus an active zonal shift changes what Auto Scaling does when that same fault fires.

### Why `ReplaceUnhealthy`, and why it isn't automatic

AWS's own documentation on [Auto Scaling group Availability Zone distribution](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-availability-zone-balanced.html) is unambiguous about why G-2 behaved the way it did:

> Amazon EC2 Auto Scaling automatically tries to maintain equivalent numbers of instances in each enabled Availability Zone. Amazon EC2 Auto Scaling does this by attempting to launch new instances in the Availability Zone with the fewest instances. **If the attempt fails, however, Amazon EC2 Auto Scaling attempts to launch the instances in another Availability Zone until it succeeds.**

AZ-avoidance is keyed on a **launch failure** (no capacity, no free subnet IPs, Spot price above the max). A network partition never causes one — the instance boots cleanly in AZ-1; it just becomes unreachable afterward, which surfaces as a target-group health-check failure, a signal the AZ-avoidance logic isn't watching.

[Auto Scaling group zonal shift](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-zonal-shift.html) closes that gap, but deliberately, not automatically — an operator (or an automated practice run) has to declare the AZ impaired first:

> **Scaling out** – Auto Scaling will launch all new capacity requests in the healthy Availability Zones.
>
> | Impaired AZ health check behavior | Health check behavior |
> |---|---|
> | Replace unhealthy | Instances that appear unhealthy will be replaced in all Availability Zones. |
> | Ignore unhealthy | Instances will not be replaced in the Availability Zone with the active zonal shift. |

Read together: with **`ReplaceUnhealthy`** selected, unhealthy instances are still replaced — but *while a zonal shift is active*, "scaling out" (which launching a replacement counts as) happens in the healthy AZs. This workspace defaults to `ReplaceUnhealthy` specifically because it's the setting that answers the practical question G-2 raised: *can we make new capacity actually land in the healthy AZ?* `IgnoreUnhealthy` (AWS's own recommendation for pre-scaled capacity plans) is the other supported mode — no replacement at all in the impaired AZ, no churn — see [`parameters/dev-params.ts`](parameters/dev-params.ts) for how to switch.

## Prerequisites

- AWS CLI v2 installed and configured
- Node.js 20 or later
- AWS CDK CLI (`npm install -g aws-cdk`)
- Basic knowledge of TypeScript and AWS networking
- AWS account with the FIS service-linked role (auto-created on first FIS use)
- IAM permissions for `arc-zonal-shift:StartZonalShift` / `CancelZonalShift` / `ListManagedResources` (an operator action, not something FIS or CDK performs)

## Project Directory Structure

```text
fis-arch-h-zonal-shift/
├── bin/
│   └── fis-arch-h-zonal-shift.ts          # App entry point (Stage instantiation)
├── lib/
│   ├── stages/
│   │   └── fis-chaos-stage.ts              # Stage: BaseStack → AppStack → FisStack
│   └── stacks/
│       ├── base-stack.ts                   # 2-AZ VPC + Aurora PostgreSQL Multi-AZ (same as Architecture G)
│       ├── app-stack.ts                    # EC2 ASG (zonal-shift-enabled) + Network Load Balancer
│       └── fis-stack.ts                    # 1 FIS experiment template (H-1) + IAM + alarm
├── parameters/
│   ├── environments.ts                     # Environment parameter type (+ impairedZoneHealthCheckBehavior)
│   ├── dev-params.ts                       # Development environment parameters
│   └── index.ts                            # Parameter exports
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts                # cdk-nag AwsSolutions compliance checks
│   └── snapshot/
│       └── snapshot.test.ts               # CDK snapshot tests
├── overview.drawio.svg                    # Architecture diagram (FIS fault + ARC response)
├── cdk.json
├── package.json
└── tsconfig.json
```

## Data Flow

```text
Viewer ── HTTPS ──► NLB ── TCP/80 ──► ASG instance (AZ-1 or AZ-2) ── nginx status page

FIS (the fault):
  H-1  aws:network:disrupt-connectivity (scope=all) ──► AZ-1 subnet

ARC zonal shift (the response — operator/API-triggered, not FIS):
  aws arc-zonal-shift start-zonal-shift --resource-identifier <ASG ARN> --away-from <AZ-1 AZ ID>
    └─► ASG treats AZ-1 as impaired for the duration of the shift
        └─► ReplaceUnhealthy: new/replacement instances launch in AZ-2 instead
```

## Key Components and Design Points

| Component | Design Points |
| --------- | -------------- |
| EC2 Auto Scaling Group | `AvailabilityZoneImpairmentPolicy: { zonalShiftEnabled: true, impairedZoneHealthCheckBehavior: 'ReplaceUnhealthy' }` — set via the L1 `CfnAutoScalingGroup` escape hatch since aws-cdk-lib 2.270.0's L2 construct doesn't expose this property yet |
| Instance maintenance policy | `minHealthyPercentage: 100`, `maxHealthyPercentage: 150` — AWS's documented best practice for zonal-shift-enabled ASGs: launch the replacement before terminating the old instance, so a rolling replacement never drops capacity |
| NLB | `crossZoneEnabled: true` — avoids the extra `skip-zonal-shift-validation` requirement AWS documents for cross-zone-*disabled* load balancers |
| FIS IAM Role | `ec2:DescribeSubnets`/`DescribeNetworkAcls`/`CreateNetworkAcl`/... for `aws:network:disrupt-connectivity`'s NACL-swap mechanism; `cloudwatch:DescribeAlarms` on the stop-condition alarm. No `arc-zonal-shift:*` — FIS never touches zonal shift; the operator does |
| CloudWatch Stop Alarm | NLB target group `UnHealthyHostCount >= 2` — identical stop condition to Architecture G |

## Implementation Highlights

### 1. `AvailabilityZoneImpairmentPolicy` via the L1 escape hatch

```typescript
// lib/stacks/app-stack.ts (excerpt)
const cfnAsg = this.asg.node.defaultChild as autoscaling.CfnAutoScalingGroup;
cfnAsg.availabilityZoneImpairmentPolicy = {
    zonalShiftEnabled: true,
    impairedZoneHealthCheckBehavior: props.impairedZoneHealthCheckBehavior ?? 'ReplaceUnhealthy',
};
```

`aws-cdk-lib` 2.270.0's L2 `AutoScalingGroup` construct doesn't expose `AvailabilityZoneImpairmentPolicy` as a typed prop yet — the underlying `CfnAutoScalingGroup` (accessible via `.node.defaultChild`) does. This registers the ASG with ARC zonal shift at deploy time; no zonal shift is *active* until an operator starts one (step 6 below).

### 2. The instance maintenance policy AWS recommends alongside zonal shift

```typescript
minHealthyPercentage: 100,
maxHealthyPercentage: 150,
```

Without this, Auto Scaling's default behavior can terminate an old (unhealthy) instance before the new one is ready, briefly dropping below desired capacity during a replacement. `100/150` guarantees the old instance stays up until its replacement is healthy — recommended explicitly in the [zonal shift best practices](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-zonal-shift.html#asg-zonal-shift-best-practices).

### 3. The FIS template is deliberately unchanged from Architecture G's G-2

```typescript
// lib/stacks/fis-stack.ts (excerpt)
actions: {
    DisruptAllTraffic: {
        actionId: 'aws:network:disrupt-connectivity',
        parameters: { scope: 'all', duration: 'PT5M' },
        targets: { Subnets: 'Az1Subnet' },
    },
},
```

Same action, same scope, same target, same duration as G-2. If H-1 produced a different observable outcome than G-2, it can only be because of the zonal shift — not because the fault itself changed.

## Deployment Guide

### 1. Install dependencies

```bash
cd infrastructure
npm ci
```

### 2. Configure environment parameters

```typescript
// parameters/dev-params.ts
export const devParams: EnvParams = {
    region: 'ap-northeast-1',
    impairedZoneHealthCheckBehavior: 'ReplaceUnhealthy', // or 'IgnoreUnhealthy'
    // alarmEmail: 'ops@example.com',
};
```

### 3. Bootstrap CDK (first time only)

```bash
PROJECT=<project> ENV=dev npm run bootstrap -w workspaces/fis-arch-h-zonal-shift
```

### 4. Deploy all stacks

```bash
PROJECT=<project> ENV=dev npm run stage:deploy:all -w workspaces/fis-arch-h-zonal-shift -- --require-approval never
```

Deploys three stacks in order: `<project>-dev-h-base` (VPC + Aurora), `<project>-dev-h-app` (ASG + NLB), `<project>-dev-h-fis` (FIS template H-1).

### 5. Confirm the ASG is registered with ARC zonal shift

```bash
ASG_ARN=$(aws cloudformation describe-stacks --stack-name <project>-dev-h-app \
  --query "Stacks[0].Outputs[?OutputKey=='AsgArn'].OutputValue" --output text)

aws arc-zonal-shift list-managed-resources \
  --query "items[?arn=='$ASG_ARN']"
```

### 6. Start a zonal shift, then run the FIS experiment

Resolve AZ-1's AZ *ID* (not its name — `start-zonal-shift` takes the ID form, e.g. `apne1-az1`):

```bash
AZ1_NAME=$(aws cloudformation describe-stacks --stack-name <project>-dev-h-base \
  --query "Stacks[0].Outputs[?OutputKey=='Az1SubnetArn'].OutputValue" --output text | \
  xargs -I{} aws ec2 describe-subnets --subnet-ids $(basename {}) --query "Subnets[0].AvailabilityZone" --output text)
AZ1_ID=$(aws ec2 describe-availability-zones --filters "Name=zone-name,Values=$AZ1_NAME" \
  --query "AvailabilityZones[0].ZoneId" --output text)

# Start a zonal shift away from AZ-1, valid for 1 hour
aws arc-zonal-shift start-zonal-shift \
  --resource-identifier "$ASG_ARN" \
  --away-from "$AZ1_ID" \
  --expires-in 1h \
  --comment "H-1 verification — compare replacement placement with G-2"
```

Then start the H-1 experiment template (console or `aws fis start-experiment`) and observe where Auto Scaling launches the replacement instance:

```bash
watch -n 10 "aws autoscaling describe-auto-scaling-instances \
  --query \"AutoScalingInstances[].{id:InstanceId,az:AvailabilityZone,health:HealthStatus}\" --output table"
```

### 7. End the zonal shift

```bash
aws arc-zonal-shift list-zonal-shifts --resource-identifier "$ASG_ARN"
aws arc-zonal-shift cancel-zonal-shift --zonal-shift-id <id-from-above>
```

### Observed results (ap-northeast-1)

Deploy-verified end-to-end, including both halves of the comparison, in the same live
infrastructure:

| Condition | Where the replacement instance landed |
| --------- | -------------------------------------- |
| **No active zonal shift** (control) | AZ-1 — the same partitioned AZ, reproducing Architecture G's G-2 result exactly |
| **Active zonal shift, `ReplaceUnhealthy`** | **AZ-2** — the healthy AZ |

Timeline for the zonal-shift-active run: the AZ-1 target flipped to
`unhealthy`/`Target.FailedHealthChecks` within seconds of H-1 starting; a new instance
launched and — confirmed via `describe-instances` — landed in `ap-northeast-1c` (AZ-2);
the old AZ-1 instance stayed `InService` until the new one passed target-group health
checks (the `minHealthyPercentage: 100` maintenance policy working as designed), then
moved to `Terminating`. Final state: 2 healthy instances in AZ-2, the AZ-1 instance
gone.

For the control run (zonal shift canceled via `cancel-zonal-shift`, confirmed via
`list-zonal-shifts` returning no active shifts before starting), the same H-1 template
against the same fault produced a replacement that landed back in AZ-1 — matching
Architecture G's G-2 finding precisely, in the same workspace's own infrastructure
rather than by comparison across two different deployments.

**This directly answers the question that motivated this workspace**: capacity *can*
be made to move to the healthy AZ during an AZ-level event, but only through an
explicit, operator-triggered mechanism (`AvailabilityZoneImpairmentPolicy` +
`start-zonal-shift`) — never as Auto Scaling's own default behavior.

## Testing

```bash
cd infrastructure
npm ci

npm run test           -w workspaces/fis-arch-h-zonal-shift
npm run test:snapshot  -w workspaces/fis-arch-h-zonal-shift
npm run test:compliance -w workspaces/fis-arch-h-zonal-shift
npm run test:snapshot:update -w workspaces/fis-arch-h-zonal-shift   # after intentional changes
```

| Test suite | File | Assertions |
| ---------- | ---- | ---------- |
| Snapshot | `test/snapshot/snapshot.test.ts` | Full CFn snapshots for all 3 stacks; ASG has `AvailabilityZoneImpairmentPolicy` with `ZonalShiftEnabled:true`; ASG has a 100/150 instance maintenance policy; NLB is internet-facing; exactly 1 FIS template with a stop condition, using `aws:network:disrupt-connectivity` against `aws:ec2:subnet` |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutions pack — no unsuppressed findings |

## Cost Estimation

Same idle-cost profile as Architecture G (a NAT Gateway + two Aurora Serverless v2 ACUs dominate, ~$200+/month if left running — destroy promptly after experiments). A single H-1 test cycle costs a few dollars: FIS's $0.10/action-minute for one 5-minute run, plus a brief EC2 replacement. ARC zonal shift itself has no separate charge.

## Security Considerations

- **ASG zonal shift registration is opt-in and scoped to this ASG** — `AvailabilityZoneImpairmentPolicy` only affects this workspace's own Auto Scaling group.
- **Starting/ending a zonal shift requires `arc-zonal-shift:StartZonalShift`/`CancelZonalShift`** — scope this to the specific ASG ARN in any non-admin IAM policy; it is an operator action, not something granted to the FIS role.
- **FIS role unchanged from Architecture G's G-1/G-2 scope**: NACL-swap permissions for `aws:network:disrupt-connectivity`, `cloudwatch:DescribeAlarms` on the one stop-condition alarm. No EC2-terminate or Aurora-failover permissions (H doesn't use those actions).
- **No VPC exposure** beyond the internet-facing NLB, identical to Architecture G.
- **Stop condition is mandatory** — H-1 carries the same NLB unhealthy-host alarm stop condition as every FIS template in this series.

## Troubleshooting

| Symptom | Likely cause | Resolution |
| ------- | ------------ | ---------- |
| `start-zonal-shift` fails: `ResourceNotFoundException` | ASG not yet registered with ARC, or the wrong resource identifier | Confirm the ASG's `AvailabilityZoneImpairmentPolicy.ZonalShiftEnabled` is `true` (deploy step 4) and use the ASG **ARN** (from the `AsgArn` stack output), not its name |
| `start-zonal-shift` fails: `AccessDeniedException` | Caller lacks `arc-zonal-shift:StartZonalShift` | This is an operator/IAM-user permission, not something the FIS role or CDK grants — add it to your own principal |
| `--away-from` rejected | AZ *name* (`ap-northeast-1a`) passed instead of AZ *ID* (`apne1-az1`) | Resolve the ID first: `aws ec2 describe-availability-zones --filters "Name=zone-name,Values=<az-name>"` |
| Replacement still lands in AZ-1 despite an active shift | `ImpairedZoneHealthCheckBehavior` is `IgnoreUnhealthy`, not `ReplaceUnhealthy` | Under `IgnoreUnhealthy`, AWS deliberately does **not** replace the unhealthy instance at all (see the behavior table above) — this is expected, not a bug; redeploy with `ReplaceUnhealthy` to see replacement-in-AZ-2 behavior |
| FIS experiment stops immediately | Stop condition alarm already in `ALARM` | `aws cloudwatch set-alarm-state --alarm-name <name> --state-value OK --state-reason reset` |

## Clean-up

```bash
# Cancel any active zonal shift first — it is independent of the CDK stacks
aws arc-zonal-shift list-zonal-shifts --resource-identifier "$ASG_ARN"
aws arc-zonal-shift cancel-zonal-shift --zonal-shift-id <id>

PROJECT=<project> ENV=dev npm run stage:destroy:all -w workspaces/fis-arch-h-zonal-shift -- --force
```

Zonal shift registration itself is a property of the ASG and is removed automatically when the ASG is deleted — no separate cleanup needed beyond ending any *active* shift.

## Summary

Architecture G's G-2 scenario deploy-verified a real gap: Auto Scaling's default self-healing can't tell a network partition from a dead instance, and re-launches replacements into the same broken AZ because its AZ-avoidance logic only reacts to launch failures. This workspace closes that gap with a documented AWS mechanism — ARC zonal shift — and deploy-verifies it against the *exact same fault*:

- **H-1 without an active shift** reproduces G-2's result as a control.
- **H-1 with an active shift** (`ReplaceUnhealthy`) is expected to show replacement capacity landing in AZ-2 instead of AZ-1.

This is not a new chaos scenario so much as a resolution to one already found — the question this workspace answers is "does AWS give you a way to fix this," and the answer, deploy-verified, is yes: `AvailabilityZoneImpairmentPolicy` plus an operator-triggered zonal shift.

## References

- [Auto Scaling group zonal shift](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-zonal-shift.html)
- [Auto Scaling group Availability Zone distribution](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-availability-zone-balanced.html)
- [Auto Scaling benefits for application architecture](https://docs.aws.amazon.com/autoscaling/ec2/userguide/auto-scaling-benefits.html)
- [`AWS::AutoScaling::AutoScalingGroup AvailabilityZoneImpairmentPolicy`](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-autoscaling-autoscalinggroup-availabilityzoneimpairmentpolicy.html)
- [Using zonal shift with Amazon EC2 Auto Scaling (AWS Compute Blog)](https://aws.amazon.com/blogs/compute/using-zonal-shift-with-amazon-ec2-auto-scaling/)
- [`start-zonal-shift` CLI reference](https://docs.aws.amazon.com/cli/latest/reference/arc-zonal-shift/start-zonal-shift.html)
- Architecture G — [fis-arch-g-multiaz-network](../fis-arch-g-multiaz-network) — the workspace whose G-2 finding this one directly follows up on
