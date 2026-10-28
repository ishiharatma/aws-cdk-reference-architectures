# ECS Fargate Spot Capacity Provider Strategy and AZ Rebalancing — Measured Behavior

A service with a capacity provider strategy (`FARGATE base 2, weight 1` + `FARGATE_SPOT weight 3`,
desired 6, three AZs, ALB) was deploy-verified in
[`ecs-fargate-spot-capacity-provider`](../../infrastructure/workspaces/ecs-fargate-spot-capacity-provider/)
on 2026-10-28 (ap-northeast-1, aws-cdk-lib 2.273.0). Single runs unless stated.

Sources:
[Fargate capacity providers](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-capacity-providers.html) /
[Balancing a service across AZs](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-rebalancing.html) /
[AWS::ECS::Service](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ecs-service.html)

## AZ rebalancing default — the docs disagree, measure it

- The CloudFormation/API reference and the rebalancing guide say: on create, an unspecified
  `AvailabilityZoneRebalancing` becomes `ENABLED`; on update, the current value is kept (a service
  that never had a value is treated as `DISABLED`). The rebalancing guide adds that "starting
  September 5, 2025, Amazon ECS enables Availability Zone rebalancing for all services that are
  eligible" (AZ spread first or no placement strategy).
- The **service definition parameters** page still says the default for new services is `DISABLED`.
- Measured with `aws ecs create-service` without the parameter:

  | Service | `availabilityZoneRebalancing` |
  | --- | --- |
  | launch type `FARGATE` | `ENABLED` |
  | strategy `FARGATE_SPOT weight 1` | `ENABLED` |
  | launch type `FARGATE`, `maximumPercent=100` | **`DISABLED`, no error or warning** |
  | `update-service` without the parameter on the first one | stays `ENABLED` |

- **CDK omits the property when unset** (`FargateService.availabilityZoneRebalancing` is passed
  through as `undefined`; the JSDoc says `@default ENABLED`, but that is the service's default, not
  something CDK writes). CDK only validates `ENABLED` + `maxHealthyPercent: 100` and Classic LB.
- Practical rule: set `ENABLED` explicitly and keep `maxHealthyPercent > 100`. Check old services
  with `aws ecs describe-services --query 'services[].availabilityZoneRebalancing'`.

## Strategy split and AZ placement

- Desired 6 → 3 `FARGATE` (base 2 + 4 × 1/4) and 3 `FARGATE_SPOT`; each AZ got exactly one task
  of each provider (the guide: "If the capacity provider includes both Fargate and Fargate Spot,
  the spread behavior is independent for each capacity provider").
- Scaled to 9 → 4 `FARGATE` + 5 `FARGATE_SPOT` (the 7 weighted tasks split 1.75 / 5.25, rounded to
  2 / 5). `splitByStrategy()` in the workspace reproduces this with base-first + largest remainder.
- **Scale-in looked at the total per AZ, not per provider**: going from 9 (1a=4, 1c=2, 1d=3; SPOT
  2/1/2) back to 6 stopped two SPOT tasks in 1a, leaving SPOT at 0/1/2 and the total at 1/2/3.
  AZ rebalancing corrected it later (below).
- Fargate Spot does not run ARM64 tasks; pin `X86_64`. Fargate Spot prices are not in the Pricing
  API (`AmazonECS` in ap-northeast-1 lists only `APN1-Fargate-vCPU-Hours:perCPU` $0.05056 and
  `APN1-Fargate-GB-Hours` $0.00553 for x86 Linux).

## How base and weight split the tasks (measured, 24 points)

Temporary cluster, services with `FARGATE base 1, weight 1` + `FARGATE_SPOT weight k`, desired raised
3 → 14 one step at a time:

| Desired | 3 | 4 | 5 | 6 | 7 | 8–11 | 12 | 13 | 14 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `1:6` on-demand / Spot | 1/2 | 1/3 | 2/3 | 2/4 | 2/5 | 2/6–9 | 3/9 | 3/10 | 3/11 |
| `1:11` on-demand / Spot | 1/2 | 1/3 | 1/4 | 1/5 | 2/5 | 2/6–9 | 2/10 | 2/11 | 2/12 |
| `1:3` on-demand / Spot | 2/1 | 2/2 | 2/3 | 2/4 | | | | | |

- Rule that reproduces every point: `on-demand = base + round((desired − base) × w_od / (w_od + w_spot))`,
  ties (exact .5) going to the provider listed first (`FARGATE`). Largest-remainder allocation of the
  weighted part gives the same result.
- Consequence: the first extra on-demand task comes at `base + ceil((k + 1) / 2)` (half an interval
  early), then one every `k + 1` tasks. Weights cannot express a hard threshold.
- Each provider is spread on its own, so `FARGATE 1 + FARGATE_SPOT 1` does not guarantee two AZs;
  `FARGATE_SPOT 2` does (while Spot is available), `FARGATE base 2` does even without Spot.

## AZ rebalancing timing (measured)

Service events after the scale-in above (desired 6, imbalance 1/2/3):

| Time (UTC) | Service event |
| --- | --- |
| 14:24:19 | `has reached a steady state.` |
| 14:39:26 | `is not AZ balanced with 1 tasks in ap-northeast-1a, 2 tasks in ap-northeast-1c, 3 tasks in ap-northeast-1d. AZ Rebalancing in progress.` |
| 14:39:26 | `has started 1 tasks in ap-northeast-1a to AZ Rebalance` |
| 14:40:43 | `has stopped 1 running tasks` (in 1d, after the new task passed health checks) |
| 14:40:52 | `is AZ balanced with 2 tasks in ap-northeast-1a, 2 tasks in ap-northeast-1c, 2 tasks in ap-northeast-1d.` |

- **About 15 minutes passed between the steady state and the start of rebalancing**; the move
  itself took about 90 s (start → healthy → stop, one task at a time). Two runs:

  | Run | Steady state → `is not AZ balanced` | → `is AZ balanced` |
  | --- | --- | --- |
  | 1 | 15 min 07 s | 86 s |
  | 2 | 15 min 27 s | 88 s |

  Do not conclude "rebalancing does not work" from a few minutes of observation — an earlier run
  was abandoned after 215 s for that reason.
- The started task was `FARGATE_SPOT` in the AZ that had no SPOT task, the stopped one a SPOT task
  in the AZ with two: SPOT went 0/1/2 → 1/1/1 and the total 1/2/3 → 2/2/2.
- The event text is greppable: `is not AZ balanced` / `to AZ Rebalance` / `is AZ balanced`.

## With a mixed strategy, rebalancing works per capacity provider

The rebalancing guide says "If the capacity provider includes both Fargate and Fargate Spot, the
spread behavior is independent for each capacity provider". Measured consequence:

| State (desired) | Total per AZ | FARGATE | FARGATE_SPOT | Rebalanced? |
| --- | --- | --- | --- | --- |
| after scale-in (6) | 1 / 2 / 3 | 1 / 1 / 1 | **0 / 1 / 2** | yes, after ~15 min (twice) |
| after scale-out with one AZ full (9) | **4 / 2 / 3** | 2 / 1 / 1 | 2 / 1 / 2 | **no, 30 min observed** (twice reproduced) |

- 4/2/3 for 9 tasks is uneven in total (ECS's own rule would be 3/3/3), but each provider is within
  floor..ceil of its own count over 3 AZs (4 → 1..2, 5 → 1..2), so nothing happens. The event
  message still reports totals ("is not AZ balanced with 1 tasks in ..."), which hides this.
- Totals can only be even for both providers when each provider's task count is a multiple of the
  AZ count (6 = 3 + 3 over 3 AZs). The workspace warns at synth time otherwise
  (`splitByStrategy()` + `cdk.Annotations.addWarningV2('fgspot:uneven-az-split', ...)`).
- The scale-in from 4/2/3 to 6 was reproducible: it stopped tasks from the AZ with the most tasks
  in total (1a) and produced the same SPOT 0/1/2 both times. A third run that happened to start
  from 3/2/4 (FARGATE 1/1/2, SPOT 2/1/2) scaled in straight to 2/2/2, so whether a scale-in leaves
  an imbalance depends on the starting distribution.

## Placement into a full AZ is retried with backoff, not moved

Control run: a launch-type `FARGATE` service (no strategy, no load balancer, desired 6,
rebalancing `ENABLED`) created while one AZ's subnet had no free IP.

- It reached only 4 RUNNING tasks (2 + 2 in the other AZs) and **stayed there for 20 minutes**;
  the 2 tasks meant for the full AZ were never placed elsewhere. `aws ecs wait services-stable`
  timed out.
- Retries came in bursts with growing gaps: every ~10 s at first, then ~5 minutes apart
  (14:43:55 → 14:48:54 → 14:54:12), each failing with `InsufficientFreeAddressesInSubnet`.
- After the IPs were released, the next retry (2 min 38 s later) placed both tasks: 2/2/2 at
  +183 s. This is the pending placement succeeding, not AZ rebalancing.
- Contrast: an existing service scaled out while the AZ was full placed the new tasks in the
  other AZs (above). Do not assume a new service or replacement tasks route around an AZ that
  cannot take an ENI.

## A full subnet: what the scheduler does

The impairment was simulated by occupying every free IP of one AZ's private subnet with temporary
ENIs (secondary IPs, 49 per ENI; a `/24` took 5 ENIs). Findings:

- **Replacements retry the same AZ.** After `StopTask` on the two tasks of the full AZ, ECS started
  replacements immediately (max 200%) and kept placing them in that AZ: 18 consecutive
  `TaskFailedToStart` / `SERVICE_TASK_CONFIGURATION_FAILURE` with `Unexpected EC2 error while
  attempting to Create Network Interface in subnet '<subnet>': InsufficientFreeAddressesInSubnet`,
  about every 9 s for 2 minutes. It did not fall back to the other AZs.
- **Stopping tasks does not empty an AZ.** A stopped task keeps its ENI (and IP) through
  deregistration delay + `stopTimeout`; when it finally stops, the retrying replacement takes the
  freed IP. Both replacements ended up in the "impaired" AZ again.
- **Scale-out does go around it.** With the AZ full, scaling 6 → 9 placed all new tasks in the other
  AZs within 52 s (1a=4, 1c=2, 1d=3).
- To exercise rebalancing reproducibly with a mixed strategy: fill the subnet, scale out, release
  the IPs, scale back in (see `test-spot.sh rebalance`). Raise and restore the scaling minimum
  together with the desired count, or target tracking may scale in on its own.

## Stopping a task behind an ALB (StopTask, measured)

Deregistration delay 30 s, `stopTimeout` 120 s, application drains 15 s after SIGTERM, ~4 req/s:

| Elapsed | Event |
| --- | --- |
| +0.7 s | task `DEACTIVATING` |
| +8.1 s | target `draining` |
| +38.1 s | target gone |
| +54.1 s | task `STOPPING`; SIGTERM logged at +54.9 s |
| +69.9 s | process exit |
| +104.8 s | task `STOPPED` |

553 requests, all 200. For scheduler-initiated stops ECS deregisters and waits for the delay
**before** SIGTERM; a Spot interruption sends SIGTERM with the two-minute warning (stop code
`TerminationNotice`), so the application's own drain is what protects requests there. Keep
deregistration delay + drain below 120 s.

## CDK: the service must depend on the capacity provider association

- `new ecs.Cluster({ enableFargateCapacityProviders: true })` synthesizes an
  `AWS::ECS::ClusterCapacityProviderAssociations` (logical id `Cluster<hash>` under the cluster
  construct). A `FargateService` with `capacityProviderStrategies` does **not** get a `DependsOn` on
  it (aws-cdk-lib 2.273.0).
- `cdk destroy` then deleted the association in parallel with the service and failed:
  `DELETE_FAILED ... AWS::ECS::ClusterCapacityProviderAssociations ... The specified capacity provider
  is in use and cannot be removed. (... ResourceInUseException ...)`. Stack events showed the
  association's `DELETE_IN_PROGRESS` 3 s before the service's.
- Fix: `service.node.addDependency(cluster)` (adds both the cluster and the association to
  `DependsOn`). Verified with a fresh deploy (298 s) and destroy (310 s) in one pass. Recovery for a
  stack already in `DELETE_FAILED`: once the service is `INACTIVE`, `delete-stack` again succeeds.
- ECS leaves `/aws/ecs/containerinsights/<cluster>/performance` after the stack is gone.

## EventBridge patterns that worked

- Spot warnings: `source: aws.ecs`, `detail-type: ECS Task State Change`,
  `detail.clusterArn: [<arn>]`, `detail.stopCode: [TerminationNotice]` (none occurred during the test).
- Every stop with reason: same with `detail.lastStatus: [STOPPED]` — captured `UserInitiated`,
  `TaskFailedToStart` with the full EC2 error, scale-in (`ServiceSchedulerInitiated` /
  `Scaling activity initiated by (deployment ecs-svc/...)`) and rebalancing
  (`ServiceSchedulerInitiated` / `Availability-zone rebalancing initiated by (deployment ecs-svc/...)`),
  so rebalancing moves can be counted with a filter on `stoppedReason`.
- Placement failures and steady states: `detail-type: ECS Service Action` (`SERVICE_STEADY_STATE`,
  `CAPACITY_PROVIDER_STEADY_STATE`, `SERVICE_TASK_CONFIGURATION_FAILURE`).
- Log group names must start with `/aws/events/` for the CloudWatch Logs target.
