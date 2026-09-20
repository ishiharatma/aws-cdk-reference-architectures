# AWS FIS Chaos Engineering — Gotchas

Verified against `aws fis list-actions` in `ap-northeast-1` and real deploy-verified
experiments across the `fis-arch-*` workspaces (A through H) in this repo.

## Actions that sound plausible but don't exist

`aws fis list-actions` is the only source of truth — the action catalogue is smaller
than intuition suggests, and CloudFormation's failure mode when you guess wrong gives
almost no help (`Invalid actionId ... 404`, nothing more specific).

- **`aws:lambda:put-function-concurrent-executions`** — does not exist. There is no FIS
  action that sets a Lambda function's reserved concurrency. This was independently
  reached for in **two unrelated workspaces** in this repo
  (`fis-arch-d-sqs-lambda` and `fis-arch-f-stepfunctions-saga`) before either was
  deploy-verified — it is the single most intuitive-sounding way to "disable a Lambda"
  via FIS, and it simply isn't real. The actual, supported way to inject faults into a
  Lambda function is the `aws:lambda:function` action family, injected through the
  **AWS FIS Lambda extension** (a layer):
  - `aws:lambda:invocation-error` — every (or a percentage of) invocations fail;
    `preventExecution: 'true'` fails before the handler runs at all (fail-fast, no
    side effects), `'false'` lets the handler run and then reports the failure
    (fail-after-commit — a real idempotency test in disguise).
  - `aws:lambda:invocation-add-delay` — adds a fixed startup delay
    (`startupDelayMilliseconds`) before the handler runs.
  - `aws:lambda:invocation-http-integration-response` — for API Gateway-fronted
    Lambdas, returns a synthetic HTTP status/body without running the handler.

  Extension setup (see `fis-arch-b-apigw-lambda`, `-d-sqs-lambda`, `-f-stepfunctions-saga`
  for working examples): attach the layer (resolved per-Region from the public SSM
  parameter `/aws/service/fis/lambda-extension/AWS-FIS-extension-x86_64/1.x.x`), set
  `AWS_LAMBDA_EXEC_WRAPPER=/opt/aws-fis/bootstrap`,
  `AWS_FIS_CONFIGURATION_LOCATION=arn:aws:s3:::<bucket>/<prefix>/`, and
  `AWS_FIS_POLL_MAX_WAIT_MILLISECONDS=2000` (recommended for `preventExecution=true`).
  FIS writes the active fault config to that S3 prefix; the extension **polls** it —
  expect up to ~60s ramp-up after `start-experiment` before every invocation is
  affected, and ~20s ramp-down after the action ends. A 50%-percentage action can take
  several minutes to statistically converge.

- **`aws:ecs:network-blackhole-port`** — wrong name. The real action is
  `aws:ecs:task-network-blackhole-port`.

- **`aws:fis:inject-api-internal-error` / `aws:fis:inject-api-throttle-error`** — these
  have a short, easy-to-miss allow-list for the `service` parameter (as of 2026, roughly
  `ec2`/`kinesis`-class services). `service: dynamodb` and `service: sqs` are both
  rejected with *"The service parameter value is not supported for the action"*. These
  are **not** a general "make any AWS API fail" tool — check the allow-list before
  assuming they'll work for a given service.

## `aws:ecs:task-*` actions have real, undocumented-at-a-glance infrastructure prerequisites

(`fis-arch-a-ecs-aurora`) The container/network-fault actions targeting ECS tasks
(`task-network-blackhole-port`, `-latency`, `-packet-loss`, `-cpu-stress`,
`-io-stress`, `-kill-process`) route through an SSM document, which means the task
itself must be reachable as an SSM managed instance:

- A dedicated `amazon-ssm-agent` **sidecar container** running the verbatim AWS-FIS
  registration script (`ssm create-activation` → register → deregister on `SIGTERM`)
- A managed-instance IAM role (`AmazonSSMManagedInstanceCore` +
  `ssm:DeleteActivation` + `ssm:DeregisterManagedInstance`)
- Task role: `ssm:CreateActivation`, `ssm:AddTagsToResource`, `iam:PassRole` scoped to
  the managed-instance role
- `enableFaultInjection: true` + `pidMode: task` on the task definition (the latter
  also forces an explicit `runtimePlatform` on Fargate)
- **ECS Exec must be disabled** (`enableExecuteCommand: false`) — its own SSM agent
  process conflicts with the sidecar's
- Network actions additionally need `useEcsFaultInjectionEndpoints: 'true'` in the
  action parameters
- FIS role: `ecs:DescribeTasks` + `ssm:SendCommand`/`ListCommands`/`CancelCommand`

Target with `parameters: { cluster, service }`, not a `filters` entry on
`cluster.clusterArn` — the latter resolves to an empty target set with no useful error.

## `aws:ec2:terminate-instances` / SSM-document actions on EC2

(`fis-arch-c-ec2-asg-rds`, `-g-multiaz-network`)

- Target EC2 instances by a resource tag (`resourceTags`), not hard-coded instance IDs
  — this is what lets the same FIS template survive ASG scale-in/out without edits.
  Enforce the same tag in the FIS role's IAM condition (`aws:ResourceTag/<key>`) for
  defense in depth.
- `aws:ssm:send-command` (used for the `AWSFIS-Run-CPU-Stress` /
  `AWSFIS-Run-Network-Blackhole-Port` managed SSM documents) needs **`ssm:ListCommands`**
  on the FIS role, not just `ssm:SendCommand`. Without it, the command visibly starts
  (you'll see the effect briefly) and then the action fails mid-flight with *"Not
  enough privileges to perform the required action"* — a late, confusing failure
  because the missing permission is for polling status, not for sending the command.

## `aws:network:disrupt-connectivity` (Availability Zone partitions)

(`fis-arch-g-multiaz-network`, `-h-zonal-shift`) The only FIS-native action that
simulates a real AZ network partition (as opposed to a resource simply disappearing).
Implemented by swapping in a temporary Network ACL on the target subnet, then restoring
the original association when the experiment ends — so the FIS role needs
`ec2:DescribeSubnets`/`DescribeNetworkAcls`/`CreateNetworkAcl`/`CreateNetworkAclEntry`/
`DeleteNetworkAcl`/`DeleteNetworkAclEntry`/`ReplaceNetworkAclAssociation` as a wildcard
resource (the NACLs it creates don't exist at policy-authoring time).

The `scope` parameter draws a precise, useful line:
- `scope: availability-zone` — blocks only cross-AZ VPC-internal traffic to/from the
  target subnet. A resource's own ingress from a load balancer and its outbound
  internet path stay intact. Good for isolating *undeclared cross-AZ dependencies*
  from AZ-local failures.
- `scope: all` — blocks *everything* to/from the subnet, including a load balancer's
  own health-check traffic. This is what actually simulates a full AZ outage.

**A behavior worth knowing before you rely on this for an AZ-outage drill**: a
`scope: all` partition makes an Auto Scaling group's instance fail its target-group
health check, and — because Auto Scaling's AZ-avoidance logic only engages on a
*launch failure*, never a post-launch health-check failure (see
[aws-service-gotchas.md](aws-service-gotchas.md#auto-scaling-cant-tell-a-network-partition-from-a-dead-instance))
— the default self-healing response re-launches the replacement into the very same
still-partitioned AZ. Deliberately routing capacity to the healthy AZ during a real AZ
event requires [ARC zonal shift](aws-service-gotchas.md#arc-zonal-shift-on-auto-scaling),
not just "wait for Auto Scaling to fix it."

## FIS pricing

FIS is **not free**. It bills **$0.10 per action-minute**, consistently across regions
observed in this repo (`us-east-1`, `ap-northeast-1`). A single 5-minute action costs
~$0.50; a 20-minute action (e.g. `fis-arch-d`'s D-2, deliberately long to force DLQ
routing) costs ~$2 on its own. Experiment reports (opt-in) are an additional $5 each
and are not used in any workspace in this repo. Several early README drafts in this
repo stated "FIS is free" — that was wrong and has been corrected everywhere it was
found; if you see it again, it's stale.

## Stop conditions: a tripped alarm blocks *any* template referencing it, not just the "related" one

(`fis-arch-a-ecs-aurora`) FIS refuses to start an experiment if **any** stop-condition
alarm attached to that template is already in `ALARM` state — including one that looks
unrelated to the fault you're about to run. A DB-connection-count alarm that sat
permanently in `ALARM` (because the demo workload never opened a DB connection) blocked
an unrelated Aurora-failover experiment from starting at all, with an error that didn't
obviously point at "check your other alarm." Keep stop conditions few and genuinely
meaningful; an alarm that's structurally always tripped for your demo workload is worse
than no alarm.

## Verifying live, not assuming: what to check and how

- **CloudWatch metrics lag** (up to ~1 minute) — don't conclude "the fault isn't
  working" from a quiet `Errors` metric alone in the first minute. Check CloudWatch
  **Logs** instead when the FIS Lambda extension is involved — it logs its own state
  transitions (`found active faults`, `modifying the function response`,
  `persisting environment reset save file` on fault-clear), which is unambiguous
  ground truth for whether the fault is genuinely active.
- **`describe-auto-scaling-groups`' own instance-health view can lag EC2 and
  target-group reality** — after an *external* termination (FIS/EC2-initiated, not the
  ASG's own scale-in), `describe-instances` and `describe-target-health` reflect the
  true state faster than the ASG API's own instance list. Don't trust the ASG API alone
  immediately after an out-of-band termination.
- **A "successful" experiment run isn't proof it tested what its description claims**
  (`fis-arch-c`'s C-2): a CPU-stress action can run perfectly (CPUUtilization hits
  100%, holds for the full duration) while the ASG it's "supposed to" trigger
  scale-out on has no scaling policy attached at all — the action succeeded, but there
  was nothing to validate. Check what specific downstream behavior a scenario is
  supposed to trigger, and confirm that behavior actually fired, not just that the
  fault mechanism itself worked.
