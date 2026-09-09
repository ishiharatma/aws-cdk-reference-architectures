# FIS Chaos Engineering — Architecture G: Multi-AZ Network Disruption (NLB + EC2 Auto Scaling Group + Aurora PostgreSQL)

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20NLB%20%7C%20EC2%20ASG%20%7C%20Aurora%20PostgreSQL%20%7C%20VPC-orange?style=flat-square)

## Introduction

This project is a reference implementation for AWS Fault Injection Simulator (FIS) chaos engineering focused on **simulating an Availability Zone network failure**, not just a component failure. An internet-facing Network Load Balancer distributes TCP traffic across an EC2 Auto Scaling Group spread over 2 Availability Zones, backed by an Aurora PostgreSQL Serverless v2 cluster with its writer and reader placed in different AZs.

The centerpiece is `aws:network:disrupt-connectivity` — **the only FIS-native action that can simulate an AZ losing network connectivity**, and it is not used by any other workspace in this repository (`fis-arch-a` uses ECS task/network actions, `fis-arch-b` uses `aws:fis:inject-api-*` on DynamoDB, `fis-arch-c` uses SSM-based instance actions plus RDS failover). Where other architectures ask "what happens if this *component* dies?", Architecture G asks "what happens if this *Availability Zone* can no longer talk to the rest of the VPC?" — a distinct and often overlooked blast-radius category, since an AZ can fail at the network layer while every individual instance and service inside it stays perfectly healthy.

| Scenario | Fault Injected | Duration | What It Validates |
| -------- | --------------- | -------- | ------------------ |
| **G-1** AZ-1 Cross-AZ Traffic Disruption | `aws:network:disrupt-connectivity`, `scope=availability-zone`, on the AZ-1 private subnet | 5 min | Absence of undeclared cross-AZ dependencies; NLB cross-zone routing behavior when one AZ can't reach the other |
| **G-2** AZ-1 Total Isolation | `aws:network:disrupt-connectivity`, `scope=all`, on the AZ-1 private subnet | 5 min | NLB unhealthy-target detection speed; automatic failover of 100% of traffic to AZ-2 |
| **G-3** Aurora Multi-AZ Failover | `aws:rds:failover-db-cluster` — writer→reader promotion | ~30 s | DB-layer failover behavior, independent of the network-layer disruptions above |
| **G-4** AZ-scoped EC2 Termination | `aws:ec2:terminate-instances`, `PERCENT(50)` on tagged instances | Instant | ASG self-healing; NLB target deregistration/re-registration speed |

All experiments share a CloudWatch Alarm stop condition on the NLB target group's `UnHealthyHostCount` — an NLB has no per-request HTTP status-code metrics the way an ALB does, so unhealthy-host count is the safety signal available at this layer.

## Architecture Overview

```
Internet
    │
    ▼
Network Load Balancer  (internet-facing, TCP/80, 2 AZs, cross-zone load balancing)
    │  no security group of its own — EC2 ingress scoped to VPC CIDR instead
    │  (target group: preserveClientIp=false)
    ▼
EC2 Auto Scaling Group  (t3.small, AL2023, min=2/max=4, split across 2 AZs)
    │  nginx + IMDSv2 status page (instance ID + AZ)
    ▼
Aurora PostgreSQL Serverless v2  (1 writer + 1 reader, one per AZ, encrypted)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIS Experiment Templates (FisStack)

G-1  aws:network:disrupt-connectivity ──────────────► AZ-1 private subnet ARN
     scope=availability-zone, PT5M  (blocks AZ-1 → other-AZ VPC-internal traffic only)

G-2  aws:network:disrupt-connectivity ──────────────► AZ-1 private subnet ARN
     scope=all, PT5M  (blocks ALL traffic to/from the AZ-1 subnet, incl. NLB health checks)

G-3  aws:rds:failover-db-cluster ───────────────────► Aurora cluster ARN
     writer→reader promotion

G-4  aws:ec2:terminate-instances ───────────────────► EC2 instances (tag: fis-target=app-instance)
     selectionMode=PERCENT(50) — approximates "terminate one AZ's instances"
```

### VPC 2-AZ Layout

```
                                        Internet
                                           │
                                           ▼
                     Network Load Balancer (internet-facing, 2 AZs, cross-zone)
                              │                                  │
              ┌───────────────┘                                  └───────────────┐
              ▼                                                                   ▼
┌───────────────────────────────┐                                 ┌───────────────────────────────┐
│ AZ-1 (ap-northeast-1a)         │                                 │ AZ-2 (ap-northeast-1c)         │
│ ┌───────────────────────────┐ │                                 │ ┌───────────────────────────┐ │
│ │ Public   /24               │ │                                 │ │ Public   /24               │ │
│ │  NAT Gateway                │ │                                 │ │  (no NAT — routes via AZ-1) │ │
│ └───────────────────────────┘ │                                 │ └───────────────────────────┘ │
│ ┌───────────────────────────┐ │        FIS G-1 / G-2 target      │ ┌───────────────────────────┐ │
│ │ Private  /24  ◄─────────────┼─── aws:network:disrupt-          │ │ Private  /24                │ │
│ │  EC2 ASG (×1-2)             │ │    connectivity                 │ │  EC2 ASG (×1-2)             │ │
│ └───────────────────────────┘ │                                 │ └───────────────────────────┘ │
│ ┌───────────────────────────┐ │        sync replication          │ ┌───────────────────────────┐ │
│ │ Isolated /24                │ │─────────────────────────────────►│ Isolated /24                │ │
│ │  Aurora Writer               │ │                                 │ │  Aurora Reader               │ │
│ └───────────────────────────┘ │                                 │ └───────────────────────────┘ │
└───────────────────────────────┘                                 └───────────────────────────────┘
              VPC 10.70.0.0/16 — natCount=1 (single NAT Gateway shared cross-AZ)
```

### Key Design Benefits

| Feature | Benefit |
| ------- | ------- |
| `aws:network:disrupt-connectivity` | The only FIS-native way to simulate an AZ network failure without touching NACLs/route tables by hand — FIS manages the temporary NACL swap and its rollback automatically |
| `scope=availability-zone` vs `scope=all` (G-1 vs G-2) | Two distinct fault granularities from the same action: "AZ can't reach its peers" vs "AZ is completely cut off," each surfacing different failure modes |
| Aurora writer + reader across 2 AZs | G-3 (`aws:rds:failover-db-cluster`) requires at least one reader; placing it in AZ-2 also means G-1/G-2 can incidentally sever the writer's replication path, adding a secondary effect worth observing |
| NLB target group `preserveClientIp: false` | Traffic reaching EC2 targets is source-NAT'd to the NLB node's own VPC-CIDR IP, so a single simple VPC-CIDR ingress rule on the EC2 security group is sufficient — no NLB security group needed |
| Tag-based EC2 targeting (G-4) | `fis-target: app-instance` lets FIS select instances without hard-coding IDs or ASG names — survives scale-in/out cycles |
| Shared stop condition (NLB UnHealthyHostCount) | One CloudWatch Alarm halts any of the four experiments if too many targets go unhealthy |

## Prerequisites

- AWS CLI v2 installed and configured
- Node.js 20 or later
- AWS CDK CLI (`npm install -g aws-cdk`)
- Basic knowledge of TypeScript
- AWS account with FIS service-linked role created (auto-created on first FIS use)

## Project Directory Structure

```text
fis-arch-g-multiaz-network/
├── bin/
│   └── fis-arch-g-multiaz-network.ts          # App entry point (Stage instantiation)
├── lib/
│   ├── stages/
│   │   └── fis-chaos-stage.ts                  # Stage: BaseStack → AppStack → FisStack
│   └── stacks/
│       ├── base-stack.ts                       # 2-AZ VPC + Aurora PostgreSQL Serverless v2
│       ├── app-stack.ts                        # EC2 ASG (2 AZs) + internet-facing NLB
│       └── fis-stack.ts                        # 4 FIS experiment templates + IAM + alarms
├── parameters/
│   ├── environments.ts                         # Environment parameter type
│   ├── dev-params.ts                           # Development environment parameters
│   └── index.ts                                # Parameter exports
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts                    # cdk-nag AwsSolutions compliance checks
│   └── snapshot/
│       └── snapshot.test.ts                   # CDK snapshot tests (15 test cases)
├── overview.drawio.svg
├── cdk.json
├── package.json
└── tsconfig.json
```

## Data Flow

```text
Client (browser or curl)
  │  TCP/80
  ▼
Network Load Balancer  (internet-facing, 2 AZs, cross-zone load balancing)
  │  TCP listener → INSTANCE target group (preserveClientIp: false)
  ▼
EC2 Auto Scaling Group  (t3.small, AL2023, min=2/max=4, one-per-AZ minimum)
  │  nginx status page: instance ID + AZ (via IMDSv2)
  ▼
Aurora PostgreSQL Serverless v2
  │  1 writer + 1 reader, placed in different AZs (required for G-3 aws:rds:failover-db-cluster)
  │  Isolated subnets, port 5432, encrypted storage
  ▼
(Aurora secret read via Secrets Manager — optional demo DB health endpoint)
```

## Key Components and Design Points

| Component | Design Points |
| --------- | -------------- |
| VPC | CIDR 10.70.0.0/16; 2 AZs; 3 subnet tiers (public/private/isolated) per AZ; 1 NAT Gateway (shared cross-AZ) |
| Aurora PostgreSQL Serverless v2 | Engine v16.4; 1 writer + 1 reader across 2 AZs; min 0.5 ACU, max 4 ACU; isolated subnets; encrypted storage; CloudWatch log export |
| EC2 Auto Scaling Group | t3.small; AL2023; requireImdsv2; EBS gp3 encrypted 20 GB; split across 2 AZs; tag `fis-target: app-instance` |
| Network Load Balancer | Internet-facing, TCP/80, 2 AZs, cross-zone load balancing enabled, `disableSecurityGroups: true` |
| Target Group | TCP/80, INSTANCE type, `preserveClientIp: false`, HTTP health check on `/`, 30 s deregistration delay |
| EC2 Security Group | Ingress TCP/80 from the VPC CIDR only (no ingress from an NLB security group — NLB has none) |
| FIS IAM Role | `ec2:TerminateInstances` on tagged instances; NACL management actions (`ec2:CreateNetworkAcl`, `ec2:ReplaceNetworkAclAssociation`, etc.) for `aws:network:disrupt-connectivity`; `rds:FailoverDBCluster` on cluster ARN; CloudWatch Logs delivery |
| Stop Condition | NLB target group `UnHealthyHostCount >= 2` over 1 minute — shared by all 4 templates |
| FIS Log Group | `/fis/{project}-{env}` — ONE_MONTH retention, auto-deleted on stack destroy |

## Implementation Highlights

### 1. `aws:network:disrupt-connectivity` — AZ-level network fault injection (G-1, G-2)

This action targets `resourceType: aws:ec2:subnet` directly (not tag-based like most FIS actions), so the FIS templates reference the concrete subnet ARN for the AZ-1 private-with-egress subnet:

```typescript
// BaseStack: expose the private subnet ARNs, ordered by AZ
this.appSubnets = this.vpc.selectSubnets({
    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
}).subnets;
this.azSubnetArns = this.appSubnets.map((subnet) =>
    cdk.Stack.of(this).formatArn({
        service: 'ec2',
        resource: 'subnet',
        resourceName: subnet.subnetId,
    }),
);

// FisStack: G-1 uses scope=availability-zone (cross-AZ traffic only)
targets: {
    Az1Subnet: {
        resourceType: 'aws:ec2:subnet',
        resourceArns: [az1SubnetArn],
        selectionMode: 'ALL',
    },
},
actions: {
    DisruptCrossAzTraffic: {
        actionId: 'aws:network:disrupt-connectivity',
        parameters: { scope: 'availability-zone', duration: 'PT5M' },
        targets: { Subnets: 'Az1Subnet' },
    },
},

// G-2 uses scope=all (every path in/out of the subnet)
actions: {
    DisruptAllTraffic: {
        actionId: 'aws:network:disrupt-connectivity',
        parameters: { scope: 'all', duration: 'PT5M' },
        targets: { Subnets: 'Az1Subnet' },
    },
},
```

Internally, the action swaps in a temporary Network ACL on the target subnet for the duration, then restores the original association automatically — so the FIS IAM role needs NACL management permissions (`ec2:CreateNetworkAcl`, `ec2:CreateNetworkAclEntry`, `ec2:ReplaceNetworkAclAssociation`, `ec2:DeleteNetworkAcl`, `ec2:DeleteNetworkAclEntry`, `ec2:DescribeNetworkAcls`, `ec2:DescribeSubnets`) with a wildcard resource, since the temporary NACL doesn't exist when the policy is authored.

### 2. NLB without its own security group (`preserveClientIp: false`)

A Network Load Balancer forwards TCP connections at layer 4 rather than terminating them — unlike an ALB, it does not automatically hide the client's source address. This stack disables the NLB's (optional, CDK-managed) security group entirely and instead disables target-group client-IP preservation:

```typescript
this.nlb = new elbv2.NetworkLoadBalancer(this, 'Nlb', {
    // ...
    disableSecurityGroups: true,   // classic NLB behaviour: no SG of its own
});

this.targetGroup = new elbv2.NetworkTargetGroup(this, 'AsgTg', {
    // ...
    preserveClientIp: false,       // source-NAT to the NLB node's own (VPC-CIDR) IP
});

// EC2 SG: a single VPC-CIDR ingress rule is now sufficient
ec2Sg.addIngressRule(
    ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
    ec2.Port.tcp(80),
    'NLB health check and HTTP traffic (source-NAT terminated at VPC CIDR)',
);
```

With `preserveClientIp: false`, every packet the EC2 instance sees — health check or real client traffic — arrives with a source address in the VPC CIDR (the NLB node's own private IP), so the EC2 security group can be scoped just as tightly as an internal ALB pattern would allow, without needing an NLB security group to reference.

### 3. Cross-zone load balancing and the G-1/G-2 distinction

`crossZoneEnabled: true` on the NLB means a client connecting via the AZ-2 NLB node can still be routed to an AZ-1 target (and vice versa) under normal conditions. G-1 and G-2 probe two different consequences of that:

- **G-1** (`scope=availability-zone`) only blocks AZ-1 → other-AZ *VPC-internal* traffic. AZ-1's NLB node can still reach AZ-1 targets directly, and the internet path is untouched — this isolates cross-AZ dependency failures (e.g., an AZ-1 instance that can no longer reach the AZ-2 Aurora reader) from AZ-local ones.
- **G-2** (`scope=all`) blocks every path in and out of the AZ-1 subnet, including the NLB's own health-check traffic to AZ-1 instances — simulating a full AZ network failure and testing how fast the NLB detects AZ-1 as unhealthy and shifts 100% of traffic to AZ-2.

### 4. Aurora Multi-AZ failover (G-3)

Same pattern as `fis-arch-c`'s C-3: `aws:rds:failover-db-cluster` targets the cluster ARN directly, promoting the reader in AZ-2 to writer. Because the reader already sits in a different AZ from the writer, this scenario is deliberately independent of the network-layer disruptions in G-1/G-2 — it validates the database layer's own failover behavior in isolation.

### 5. AZ-scoped instance termination via 50% selection (G-4)

FIS `resourceTags` targeting has no Availability Zone condition, so there is no way to say "terminate every instance in AZ-1" directly. With the ASG split evenly across 2 AZs, `selectionMode: 'PERCENT(50)'` on the `fis-target: app-instance` tag approximates that outcome statistically without requiring hard-coded instance IDs:

```typescript
targets: {
    AppInstances: {
        resourceType: 'aws:ec2:instance',
        resourceTags: { 'fis-target': 'app-instance' },
        selectionMode: 'PERCENT(50)',
    },
},
actions: {
    TerminateInstances: {
        actionId: 'aws:ec2:terminate-instances',
        targets: { Instances: 'AppInstances' },
    },
},
```

### 6. Stop condition and safety net

All four templates share a single NLB target-group `UnHealthyHostCount` stop condition — an NLB does not expose per-request HTTP status codes the way an ALB does, so unhealthy-host count is the signal available at this layer:

```typescript
const unhealthyHostAlarm = new cw.Alarm(this, 'NlbUnhealthyHostAlarm', {
    metric: props.targetGroup.metrics.unHealthyHostCount({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
    }),
    threshold: 2,
    evaluationPeriods: 1,
    treatMissingData: cw.TreatMissingData.NOT_BREACHING,
});
```

If any experiment drives too many targets unhealthy, FIS halts it automatically and reverts the injected fault (restoring the original NACL association for G-1/G-2).

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
export const devParams: EnvParams = {
    region: 'ap-northeast-1',
    vpcConfig: { ... },
    // alarmEmail: 'ops@example.com',  // uncomment to receive alarm notifications
};
```

### 3. Bootstrap CDK (first time only)

```bash
PROJECT=fis-chaos-g ENV=dev npm run bootstrap
```

### 4. Deploy all stacks

```bash
PROJECT=fis-chaos-g ENV=dev npm run stage:deploy:all
```

This deploys the three stacks in dependency order:
1. `fis-chaos-g-dev-g-base` — 2-AZ VPC + Aurora PostgreSQL Serverless v2
2. `fis-chaos-g-dev-g-app` — EC2 ASG (2 AZs) + internet-facing NLB
3. `fis-chaos-g-dev-g-fis` — FIS templates + IAM + alarms

### 5. Test the application

After deployment, retrieve the NLB DNS name from the stack output:

```bash
# Check the nginx status page
curl http://<nlb-dns-name>/

# The response shows the instance ID and AZ:
# <h1>FIS Chaos Demo — Architecture G</h1>
# <p>Instance: i-0123456789abcdef0</p>
# <p>AZ: ap-northeast-1a</p>
# <p>Status: OK</p>
```

### 6. Run a FIS experiment

Navigate to the AWS FIS console, select one of the four experiment templates (`G-1` through `G-4`), click **Start experiment**, and observe:
- NLB target health and cross-zone routing behavior during G-1
- NLB unhealthy-target detection and AZ-2 failover speed during G-2
- Aurora Failover Events in the RDS console during G-3
- ASG activity and NLB target churn during G-4

## Testing

```bash
cd infrastructure
npm ci

# Run all tests for this workspace
npm run test --workspace=fis-arch-g-multiaz-network

# Snapshot tests only
npm run test:snapshot --workspace=fis-arch-g-multiaz-network

# CDK Nag compliance checks
npm run test:compliance --workspace=fis-arch-g-multiaz-network

# Update snapshots after intentional changes
npm run test:snapshot:update --workspace=fis-arch-g-multiaz-network
```

### What the tests cover

| Test suite | File | Assertions |
| ---------- | ---- | ---------- |
| Snapshot | `test/snapshot/snapshot.test.ts` | Full CFn template snapshots for all 3 stacks; VPC spans 2 AZs; Aurora storage encryption; ASG exists; NLB is internet-facing; target group is TCP/80; exactly 4 FIS templates; all templates have stop conditions; G-1/G-2 both target `aws:ec2:subnet` |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutions pack — no unsuppressed warnings or errors (6 test cases) |

## Cost Estimation

Aurora Serverless v2, EC2 instances, and the NAT Gateway incur hourly charges even at idle. Destroy the stack promptly after experiments.

| Service | Billing Model | Estimated cost (1-hour experiment window) |
| ------- | -------------- | ------------------------------------------- |
| EC2 (t3.small × 2) | Per hour | ~$0.04/hour |
| Aurora Serverless v2 (min 0.5 ACU × 2 instances) | Per ACU-hour | ~$0.06/hour |
| NAT Gateway | Per hour + data | ~$0.05/hour |
| Network Load Balancer | Per hour + LCU | ~$0.02/hour |
| FIS | Free | No charge |
| **Total (1-hour window)** | | **~$0.17/hour** |

## Security Considerations

- **EC2 instances require IMDSv2** (`requireImdsv2: true`) — prevents SSRF attacks via the metadata service.
- **EBS root volume encrypted** (gp3) — satisfies AwsSolutions-EC26.
- **NLB has no security group of its own; EC2 ingress is scoped to the VPC CIDR** — combined with `preserveClientIp: false` on the target group, this keeps the effective attack surface as tight as an internal-ALB pattern, without opening the instances directly to the internet.
- **FIS IAM role scoped by tag/ARN condition** — `ec2:TerminateInstances` is restricted to instances with `fis-target: app-instance`; `rds:FailoverDBCluster` is restricted to the Aurora cluster ARN.
- **Aurora in isolated subnets** — no route to the internet; accessible only from within the VPC on port 5432.
- **Stop condition is mandatory** — all FIS templates include the NLB `UnHealthyHostCount` alarm stop condition.

## Troubleshooting

| Symptom | Likely cause | Resolution |
| ------- | ------------- | ---------- |
| `cdk deploy` fails with `No parameters found` | Missing `dev-params.ts` export | Verify `parameters/index.ts` exports `devParams` under the `dev` key |
| G-1/G-2 fails with a permissions error | FIS role missing NACL management actions | Check the FIS role includes `ec2:CreateNetworkAcl`, `ec2:ReplaceNetworkAclAssociation`, etc. (wildcard resource, since the temporary NACL doesn't exist ahead of time) |
| G-3 fails with `cluster does not support failover` | No reader instance | BaseStack must deploy with `readers` array containing at least one instance |
| curl to the NLB times out | Target group unhealthy, or EC2 SG too narrow | Confirm `preserveClientIp: false` is set on the target group and the EC2 SG allows the VPC CIDR on port 80 |
| FIS experiment stops immediately | Stop condition alarm is already in `ALARM` state | Reset the alarm: `aws cloudwatch set-alarm-state --alarm-name ... --state-value OK` |

## Clean-up

```bash
PROJECT=fis-chaos-g ENV=dev npm run stage:destroy:all
```

All resources have `removalPolicy: DESTROY`, so the destroy command removes the Aurora cluster, EC2 ASG, NLB, VPC, FIS templates, and CloudWatch log groups completely.

## Summary

This workspace demonstrates FIS chaos engineering with a focus on **Availability Zone-level network failure**, a blast-radius category no other workspace in this repository covers:

- **G-1** verifies that the application has no undeclared cross-AZ dependency and that NLB cross-zone routing behaves sanely when one AZ can't reach its peers.
- **G-2** verifies NLB unhealthy-target detection speed and automatic failover to AZ-2 when an entire AZ goes network-dark.
- **G-3** verifies Aurora's own writer→reader promotion behavior, independent of the network-layer scenarios.
- **G-4** verifies ASG self-healing and NLB target churn when roughly one AZ's worth of instances disappears at once.

This architecture complements Architecture C (ALB + SSM-based instance/network actions) by covering the one failure domain neither `aws:ssm:send-command` network blackhole nor `aws:ec2:terminate-instances` can reach: an entire Availability Zone losing connectivity while every instance inside it stays healthy.

## References

- [AWS FIS — Supported actions](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [aws:network:disrupt-connectivity action reference](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-network)
- [aws:rds:failover-db-cluster action reference](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-rds)
- [Network Load Balancer — client IP preservation](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/target-group-register-targets.html)
- [Network Load Balancer — cross-zone load balancing](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/network-load-balancers.html#cross-zone-load-balancing)
- [CDK aws-fis module (L1 constructs)](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_fis-readme.html)
