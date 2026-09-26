# AWS Service Behaviors — Gotchas Worth Knowing

Things that looked like bugs in this repo's own code until root-caused against real
AWS behavior — kept here so the next workspace that touches these services doesn't
have to rediscover them from scratch.

## Aurora PostgreSQL engine versions get withdrawn from regions

`rds.AuroraPostgresEngineVersion.VER_16_4` was the version several early workspaces in
this repo were written against. AWS withdrew it from `ap-northeast-1` at some point
after those workspaces were authored — deploying against it fails with
`Cannot find version 16.4 for aurora-postgresql` / `CREATE_FAILED`, discovered only at
deploy time, not at `cdk synth`. Confirmed via
`aws rds describe-db-engine-versions --engine aurora-postgresql` that `16.13` is the
lowest currently-offered `16.x` version matching the CDK enum, in this region, as of
this repo's most recent deploy-verifications (September 2026).

**This specific bug recurred three times independently** across `fis-arch-a`,
`fis-arch-c`, and `fis-arch-g` before it started getting caught in code review instead
of a failed deploy — `fis-arch-g`'s `VER_16_4` was caught and fixed *before* deploying,
purely because the failure signature was already documented from the first two
occurrences. **If you're adding or reviewing a new workspace that provisions Aurora,
grep for `VER_16_4` (or any hardcoded old minor version) before deploying** — it's a
known, recurring trap, not a one-off.

## CDK's default NAT instance provider can pass every health check while doing nothing

(`fis-arch-a-ecs-aurora`, and the shared `alb-keycloak-auth` workspace hit the same
thing) `ec2.NatProvider.instanceV2`'s default userData runs
`yum install iptables-services -y` and configures MASQUERADE on first boot. Paired with
a `T4G.NANO` (0.5GiB RAM) NAT instance — this repo's shared VPC construct defaulted to
that size until the change described under **Fix** below — that `yum install` gets **OOM-killed** on Amazon Linux 2023 often enough to be a real
trap: the EC2 instance boots, passes every EC2/status-check health check, and never
actually NATs anything, because the one command that would have installed `iptables`
never finished.

**Symptom**: resources in a private subnet behind this NAT instance (e.g., ECS tasks
pulling secrets/images) fail with generic connectivity/timeout errors
(`ResourceInitializationError: unable to pull secrets or registry auth: ... context
deadline exceeded`) despite every security group, route table, and NACL check looking
correct. **Root-cause path that actually worked**: `aws ec2 get-console-output
--instance-id <nat-instance-id>` — the boot log shows the OOM kill directly
(`Out of memory: Killed process ... (yum) ...`, followed by
`Failed to enable unit: Unit file iptables.service does not exist.` and
`sudo: /sbin/iptables: command not found`).

**Fix**: `NatType.INSTANCE` in the shared VPC construct
(`infrastructure/common/constructs/vpc/vpc.ts`) now defaults to `T4G.MICRO` (1GiB).
This was a deliberate repo-wide change, verified end-to-end on `ecs-fargate-alb-StackSynthesizer`
(ECS tasks reached ECR through the NAT, ALB returned 200); it changed the committed
snapshots of `alb-keycloak-auth`, `ecs-fargate-alb` and `ecs-fargate-alb-StackSynthesizer`
by exactly one line (`t4g.nano` → `t4g.micro`). Workspaces that set `natInstanceType`
explicitly, or use their own NAT provider (`NatType.CUSTOM_INSTANCE`,
`vpc-natinstance-v2`), are unaffected and must be sized on their own.

**A second trap once you've found the root cause**: an EC2 instance type change via
CDK redeploy is an **in-place update**, not a replacement — and cloud-init's userData
only runs on first boot. Simply changing `instanceType` and redeploying does **not**
re-trigger the failed `yum install`, so an already-broken NAT instance stays broken
even after the "fix" is deployed. Recovering it requires a manual
`aws ec2 terminate-instances` (letting CloudFormation recreate it fresh) or a full
stack teardown+redeploy — a plain `cdk deploy` on top of the existing broken instance
will not fix it.

## First-ever `AWS::CodeStarNotifications::NotificationRule` in an account fails once

`pipeline.notifyOn(...)` creates a CodeStar Notifications rule. In an account that has
never created one, the first `cdk deploy` fails with
`Invalid request provided: AWS::CodeStarNotifications::NotificationRule` and the stack
rolls back to `ROLLBACK_COMPLETE`. The service-linked role
`AWSServiceRoleForCodeStarNotifications` is created asynchronously by that first request,
which races the rule creation. Nothing is wrong with the template: just deploy again
(CDK replaces the `ROLLBACK_COMPLETE` stack). Reproduced in two fresh accounts
(2026-09-26), both times on the `Cicd` stack of `ecs-fargate-alb-StackSynthesizer`.

## Keycloak 26 split its health/metrics endpoints onto a separate management port

(`alb-keycloak-auth`) Keycloak 26.x moved `/health/*` and `/metrics` onto a separate
"management interface," port **9000** by default — not the main HTTP port (8080) that
pre-26 layouts and most tutorials assume. An ALB target-group health check (or a
container's own Docker `HEALTHCHECK`) still pointed at `8080/health/ready` gets a
`404`, which looks like "the app isn't healthy" but is actually "you're asking the
wrong port." Confirmed by exec'ing into the running container
(`aws ecs execute-command`) and curling both ports directly — 8080 404s, 9000 returns
the real health payload.

Side note: the official `quay.io/keycloak/keycloak` image has **no `curl` or `wget`**
at all. `/bin/sh` is symlinked to `/bin/bash` in that image, so a container-level
`HEALTHCHECK` that needs to probe a port from inside the container can fall back to
bash's `/dev/tcp/<host>/<port>` pseudo-device instead of shelling out to a missing
binary.

## Keycloak's `sslRequired: external` rejects admin-API calls that don't originate from inside the VPC

(`alb-keycloak-auth`) This is Keycloak's default security posture working as intended,
not a bug — but it means a documented "run this setup script from your laptop against
the ALB's public DNS" workflow genuinely cannot work once there's no HTTPS listener yet
(e.g., before a custom domain/ACM cert is configured): every realm-scoped admin
endpoint, including the public OIDC discovery document, rejects plain-HTTP requests
from anywhere it doesn't consider "local." Spoofing `X-Forwarded-Proto: https` doesn't
help — the ALB overwrites that header with the real scheme regardless of what the
client sends.

**Fix that doesn't weaken the security setting**: make the request's origin genuinely
local by tunneling through **SSM Session Manager port forwarding** directly to the ECS
task (`aws ssm start-session --document-name AWS-StartPortForwardingSession --target
ecs:<cluster>_<taskId>_<runtimeId>`), then route the setup script's admin-API calls at
`localhost:<forwarded-port>`. From Keycloak's point of view the request is now
genuinely local, so `sslRequired` doesn't apply — nothing about the realm's security
configuration was loosened to make this work.

## Auto Scaling can't tell a network partition from a dead instance

(`fis-arch-g-multiaz-network`, `fis-arch-h-zonal-shift`) When an
`aws:network:disrupt-connectivity` `scope: all` fault makes an ASG instance fail its
target-group health check, Auto Scaling's default behavior treats that exactly the
same as the instance actually being broken: it terminates the "unhealthy" (but
network-partitioned, otherwise perfectly fine) instance and launches a replacement —
**which lands right back in the same, still-partitioned AZ**, because Auto Scaling's
AZ-avoidance logic only engages on a *launch failure* (no capacity, no free subnet
IPs, Spot price over the max), never a post-launch health-check failure. Confirmed via
AWS's own docs
([Auto Scaling benefits for application architecture](https://docs.aws.amazon.com/autoscaling/ec2/userguide/auto-scaling-benefits.html)):

> If the attempt fails, however, Amazon EC2 Auto Scaling attempts to launch the
> instances in another Availability Zone until it succeeds.

— "the attempt" here means the **launch** attempt, not the instance's subsequent
health. A network partition never fails the launch itself.

### ARC zonal shift on Auto Scaling

The documented, deliberate mechanism for making Auto Scaling actually avoid a bad AZ:
[`AvailabilityZoneImpairmentPolicy`](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-autoscaling-autoscalinggroup-availabilityzoneimpairmentpolicy.html)
on the ASG (`ZonalShiftEnabled: true`), combined with an operator-triggered
`aws arc-zonal-shift start-zonal-shift` against the ASG's ARN. Not yet exposed on
`aws-cdk-lib`'s L2 `AutoScalingGroup` (as of 2.270.0) — set it via the L1 escape hatch:
`(asg.node.defaultChild as autoscaling.CfnAutoScalingGroup).availabilityZoneImpairmentPolicy`.

Two behavior modes, and the distinction matters (deploy-verified in `fis-arch-h`):
- **`ReplaceUnhealthy`**: unhealthy instances are still replaced, but while a zonal
  shift is active, "scaling out" (which a replacement launch counts as) happens in
  the healthy AZs — this is the setting that makes capacity actually move away from a
  bad AZ.
- **`IgnoreUnhealthy`**: instances in the shifted AZ are **not replaced at all** while
  the shift is active — no churn, AWS's own recommendation for pre-scaled capacity
  plans that can already tolerate losing one AZ's worth of capacity.

`start-zonal-shift --away-from` takes an AZ **ID** (`apne1-az1`), not the AZ **name**
(`ap-northeast-1a`) — resolve it first with
`aws ec2 describe-availability-zones --filters "Name=zone-name,Values=<name>"`.

## CDK's `AutoScalingGroup#healthCheck` and L2 property lag behind CloudFormation

Newer CloudFormation properties (like `AvailabilityZoneImpairmentPolicy`, or the
deprecated-but-still-only-option-for-some-cases `HealthCheck.elb`) regularly land on
the L1 `Cfn*` construct before the corresponding L2 construct exposes a typed
convenience property, or with the L2 property already marked deprecated in favor of a
not-yet-released replacement. Check `node_modules/aws-cdk-lib/<service>/lib/*.generated.d.ts`
for the L1 property before assuming something isn't supported — access it via
`<l2construct>.node.defaultChild as Cfn<Type>` and set the property directly.
