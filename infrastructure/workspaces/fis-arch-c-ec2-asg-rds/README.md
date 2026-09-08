# FIS Chaos Engineering — Architecture C: CloudFront + Internal ALB + EC2 Auto Scaling Group + Aurora PostgreSQL

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20CloudFront%20%7C%20ALB%20%7C%20EC2%20ASG%20%7C%20Aurora%20PostgreSQL-orange?style=flat-square)

## Introduction

This project is a reference implementation for AWS Fault Injection Simulator (FIS) chaos engineering on a **classic three-tier EC2 web architecture**. A CloudFront distribution routes traffic through a VPC Origin to an internal Application Load Balancer, which distributes requests across an EC2 Auto Scaling Group running nginx on Amazon Linux 2023. The instances connect to an Aurora PostgreSQL Serverless v2 cluster.

Four FIS experiment templates inject distinct failure modes at the infrastructure layer, covering realistic production failure scenarios that cannot be tested with serverless architectures:

| Scenario | Fault Injected | Duration | What It Validates |
| -------- | -------------- | -------- | ----------------- |
| **C-1** EC2 Instance Termination | Terminates 50% of ASG instances | Instant | ASG self-healing, ALB target draining, CloudFront fallback activation |
| **C-2** EC2 CPU Stress | 100% CPU load on all instances via SSM | 5 min | ASG scale-out policy, health-check speed on new instances |
| **C-3** Aurora DB Failover | Writer→reader promotion (~30 s interruption) | ~30 s | Connection-pool reconnect, query retry logic |
| **C-4** EC2→DB Network Blackhole | Blocks TCP egress on port 5432 from all instances | 5 min | Query-timeout config, circuit-breaker activation, ALB health-check during DB loss |

All experiments share a CloudWatch Alarm stop condition that automatically halts the experiment if ALB 5xx errors exceed 50 per minute, limiting blast radius.

## Architecture Overview

```
Viewer (HTTPS)
    │
    ▼
CloudFront Distribution  (VPC Origin, cache-disabled, S3 fallback on 502/503/504)
    │  CloudFront VPC Origin (HTTP to internal ALB)
    ▼
Internal Application Load Balancer  (private subnets, CloudFront prefix list ingress)
    │  HTTP/80 listener → target group
    ▼
EC2 Auto Scaling Group  (t3.small, AL2023, min=2/max=4, private subnets, SSM agent)
    │  nginx + IMDSv2 status page
    ▼
Aurora PostgreSQL Serverless v2  (1 writer + 1 reader, isolated subnets, encrypted)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIS Experiment Templates (FisStack)

C-1  aws:ec2:terminate-instances ───────────────► EC2 instances (tag: fis-target=app-instance)
     selectionMode=PERCENT(50)

C-2  aws:ssm:send-command (AWSFIS-Run-CPU-Stress) ► EC2 instances (tag: fis-target=app-instance)
     CPU=0 (all vCPUs), DurationSeconds=300, PT5M

C-3  aws:rds:failover-db-cluster ──────────────► Aurora cluster ARN
     writer→reader promotion

C-4  aws:ssm:send-command (AWSFIS-Run-Network-Blackhole-Port) ► EC2 instances
     Protocol=tcp, TrafficType=egress, Port=5432, DurationSeconds=300, PT5M
```

### Key Design Benefits

| Feature | Benefit |
| ------- | ------- |
| SSM agent (pre-installed on AL2023) | C-2 and C-4 use AWS managed FIS SSM documents without any additional setup — no Systems Manager Fleet Manager configuration needed |
| CloudFront VPC Origin + S3 fallback | Viewers receive a branded error page (from S3) automatically during 502/503/504 windows — not a browser error |
| Writer + reader Aurora topology | C-3 (aws:rds:failover-db-cluster) requires at least one reader; the 1+1 topology is the minimal viable cluster for failover testing |
| Tag-based EC2 targeting | `fis-target: app-instance` tag lets FIS select instances without hard-coding IDs or ASG names — survives scale-in/out cycles |
| Shared stop condition (ALB 5xx) | One CloudWatch Alarm halts any of the four experiments if the error rate exceeds the safety threshold |

## Prerequisites

- AWS CLI v2 installed and configured
- Node.js 20 or later
- AWS CDK CLI (`npm install -g aws-cdk`)
- Basic knowledge of TypeScript
- AWS account with FIS service-linked role created (auto-created on first FIS use)

## Project Directory Structure

```text
fis-arch-c-ec2-asg-rds/
├── bin/
│   └── fis-arch-c-ec2-asg-rds.ts             # App entry point (Stage instantiation)
├── lib/
│   ├── stages/
│   │   └── fis-chaos-stage.ts                 # Stage: BaseStack → AppStack → FisStack
│   └── stacks/
│       ├── base-stack.ts                      # VPC + Aurora PostgreSQL Serverless v2
│       ├── app-stack.ts                       # EC2 ASG + Internal ALB + CloudFront
│       └── fis-stack.ts                       # 4 FIS experiment templates + IAM + alarms
├── parameters/
│   ├── environments.ts                        # Environment parameter type
│   ├── dev-params.ts                          # Development environment parameters
│   └── index.ts                               # Parameter exports
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts                   # cdk-nag AwsSolutions compliance checks
│   └── snapshot/
│       └── snapshot.test.ts                  # CDK snapshot tests (13 test cases)
├── cdk.json
├── package.json
└── tsconfig.json
```

## Data Flow

```text
Viewer (browser or curl)
  │  HTTPS
  ▼
CloudFront Distribution
  │  VPC Origin (primary, HTTP to internal ALB)
  │  S3 bucket origin (fallback on 502/503/504)
  ▼
Internal ALB  (CloudFront managed prefix list ingress, private subnets)
  │  HTTP/80 listener → INSTANCE target group
  ▼
EC2 Auto Scaling Group  (t3.small, AL2023, min=2/max=4)
  │  nginx status page: instance ID + AZ (via IMDSv2)
  │  SSM agent registered (required for C-2 and C-4)
  ▼
Aurora PostgreSQL Serverless v2
  │  1 writer + 1 reader (required for C-3 aws:rds:failover-db-cluster)
  │  Isolated subnets, port 5432, encrypted storage
  ▼
(Aurora secret read via Secrets Manager — optional demo DB health endpoint)
```

## Key Components and Design Points

| Component | Design Points |
| --------- | ------------- |
| VPC | CIDR 10.20.0.0/16; 3 subnet tiers (public/private/isolated), 1 NAT Gateway |
| Aurora PostgreSQL Serverless v2 | Engine v16.4; 1 writer + 1 reader; min 0.5 ACU, max 4 ACU; isolated subnets; encrypted storage; CloudWatch log export |
| EC2 Auto Scaling Group | t3.small; AL2023 (SSM agent pre-installed); requireImdsv2; EBS gp3 encrypted 20 GB; tag `fis-target: app-instance` |
| Internal ALB | CloudFront VPC Origin ingress (managed prefix list); HTTP/80; 30 s target deregistration delay |
| CloudFront Distribution | VPC Origin (primary) → S3 (fallback on 502/503/504); CACHING_DISABLED; REDIRECT_TO_HTTPS |
| FIS IAM Role | `ec2:TerminateInstances` on tagged instances; `ssm:SendCommand` on tagged instances + FIS documents; `rds:FailoverDBCluster` on cluster ARN; CloudWatch Logs delivery |
| Stop Condition | ALB `TARGET_5XX_COUNT >= 50` over 1 minute — shared by all 4 templates |
| FIS Log Group | `/fis/{project}-{env}` — ONE_MONTH retention, auto-deleted on stack destroy |

## Implementation Highlights

### 1. SSM-based fault injection (C-2 and C-4)

C-2 and C-4 use AWS managed SSM documents for FIS, which run on the EC2 instances via the pre-installed SSM agent on Amazon Linux 2023:

```typescript
// C-2: CPU stress on all instances
actions: {
    InjectCpuStress: {
        actionId: 'aws:ssm:send-command',
        parameters: {
            documentArn: `arn:aws:ssm:${cdk.Aws.REGION}::document/AWSFIS-Run-CPU-Stress`,
            documentParameters: JSON.stringify({
                CPU: '0',             // stress all available vCPUs
                DurationSeconds: '300',
                InstallDependencies: 'True',
            }),
            duration: 'PT5M',
        },
        targets: { Instances: 'AppInstances' },
    },
},

// C-4: block PostgreSQL egress on all instances
actions: {
    BlackholeDbPort: {
        actionId: 'aws:ssm:send-command',
        parameters: {
            documentArn: `arn:aws:ssm:${cdk.Aws.REGION}::document/AWSFIS-Run-Network-Blackhole-Port`,
            documentParameters: JSON.stringify({
                Protocol: 'tcp',
                TrafficType: 'egress',
                Port: '5432',
                DurationSeconds: '300',
                InstallDependencies: 'True',
            }),
            duration: 'PT5M',
        },
        targets: { Instances: 'AppInstances' },
    },
},
```

The SSM document ARNs use the format `arn:aws:ssm:REGION::document/AWSFIS-*` (no account ID) because these are AWS-owned managed documents. The FIS IAM role grants `ssm:SendCommand` on both the instance resource (scoped to the tag) and the document ARN separately.

### 2. Tag-based EC2 targeting (C-1, C-2, C-4)

All three EC2-targeting scenarios use the `fis-target: app-instance` tag rather than hard-coded ARNs. This survives ASG scale-in/out cycles without requiring FIS template updates:

```typescript
// ASG tag applied via CDK Tags
cdk.Tags.of(this.asg).add('fis-target', 'app-instance');

// FIS target definition
targets: {
    AppInstances: {
        resourceType: 'aws:ec2:instance',
        resourceTags: { 'fis-target': 'app-instance' },
        selectionMode: 'PERCENT(50)',  // C-1
        // or 'ALL' for C-2, C-4
    },
},
```

The FIS IAM role enforces the same tag via an IAM condition:

```typescript
new iam.PolicyStatement({
    actions: ['ec2:TerminateInstances'],
    resources: [`arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:instance/*`],
    conditions: {
        StringEquals: { 'aws:ResourceTag/fis-target': 'app-instance' },
    },
}),
```

### 3. Aurora writer→reader failover (C-3)

C-3 uses `aws:rds:failover-db-cluster` targeting the cluster ARN directly. The experiment's duration is determined by how long Aurora takes to promote the reader to writer (typically 20–30 seconds):

```typescript
targets: {
    AuroraCluster: {
        resourceType: 'aws:rds:cluster',
        resourceArns: [props.auroraCluster.clusterArn],
        selectionMode: 'ALL',
    },
},
actions: {
    FailoverAurora: {
        actionId: 'aws:rds:failover-db-cluster',
        targets: { Clusters: 'AuroraCluster' },
    },
},
```

The BaseStack provisions 1 writer + 1 reader because `aws:rds:failover-db-cluster` requires at least one reader to promote. Without a reader, the action fails with an unsupported cluster topology error.

### 4. CloudFront VPC Origin + S3 fallback

The CloudFront distribution uses an Origin Group with the internal ALB as the primary origin and an S3 bucket as the fallback for 502/503/504 responses. This means viewers see a branded error page during C-1 (instance termination) or C-4 (network blackhole) rather than a browser-level connection error:

```typescript
const originGroup = new cloudfront_origins.OriginGroup({
    primaryOrigin: vpcOrigin,          // Internal ALB via VPC Origin
    fallbackOrigin: s3Origin,          // S3 error page bucket
    fallbackStatusCodes: [502, 503, 504],
});
```

### 5. Stop condition and safety net

All four templates share a single ALB 5xx stop condition:

```typescript
const albErrorAlarm = new cw.Alarm(this, 'AlbTargetErrorAlarm', {
    metric: props.alb.metrics.httpCodeTarget(
        elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
        { period: cdk.Duration.minutes(1), statistic: 'Sum' },
    ),
    threshold: 50,
    evaluationPeriods: 1,
    treatMissingData: cw.TreatMissingData.NOT_BREACHING,
});
```

If any experiment causes a 5xx spike above the threshold, FIS halts it automatically and reverts the injected fault.

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
    cloudfrontManagedPrefixList: 'pl-58a04531',  // ap-northeast-1 CloudFront prefix list
    // alarmEmail: 'ops@example.com',             // uncomment to receive alarm notifications
};
```

### 3. Bootstrap CDK (first time only)

```bash
PROJECT=fis-chaos-c ENV=dev npm run bootstrap
```

### 4. Deploy all stacks

```bash
PROJECT=fis-chaos-c ENV=dev npm run stage:deploy:all
```

This deploys the three stacks in dependency order:
1. `fis-chaos-c-dev-c-base` — VPC + Aurora PostgreSQL Serverless v2
2. `fis-chaos-c-dev-c-app` — EC2 ASG + Internal ALB + CloudFront
3. `fis-chaos-c-dev-c-fis` — FIS templates + IAM + alarms

### 5. Test the application

After deployment, retrieve the CloudFront domain from the stack output:

```bash
# Check the nginx status page
curl https://<cloudfront-domain>/

# The response shows the instance ID and AZ:
# <h1>FIS Chaos Demo — Architecture C</h1>
# <p>Instance: i-0123456789abcdef0</p>
# <p>AZ: ap-northeast-1a</p>
# <p>Status: OK</p>
```

### 6. Run a FIS experiment

Navigate to the AWS FIS console, select one of the four experiment templates (`C-1` through `C-4`), click **Start experiment**, and observe:
- ALB target health in the EC2/ALB console during C-1
- CloudWatch CPU metric and ASG activity during C-2
- Aurora Failover Events in the RDS console during C-3
- ALB 5xx rate and SSM Command history during C-4

## Testing

```bash
cd infrastructure
npm ci

# Run all tests for this workspace
npm run test --workspace=fis-arch-c-ec2-asg-rds

# Snapshot tests only (13 test cases across 3 stacks)
npm run test:snapshot --workspace=fis-arch-c-ec2-asg-rds

# CDK Nag compliance checks
npm run test:compliance --workspace=fis-arch-c-ec2-asg-rds

# Update snapshots after intentional changes
npm run test:snapshot:update --workspace=fis-arch-c-ec2-asg-rds
```

### What the tests cover

| Test suite | File | Assertions |
| ---------- | ---- | ---------- |
| Snapshot | `test/snapshot/snapshot.test.ts` | Full CFn template snapshots for all 3 stacks; Aurora storage encryption; VPC exists; ASG exists; ALB is internal; CloudFront distribution count; exactly 4 FIS templates; all templates have stop conditions |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutions pack — no unsuppressed warnings or errors (6 test cases) |

## Cost Estimation

Aurora Serverless v2 and EC2 instances incur hourly charges even at idle. Destroy the stack promptly after experiments.

| Service | Billing Model | Estimated cost (1-hour experiment window) |
| ------- | ------------- | ----------------------------------------- |
| EC2 (t3.small × 2) | Per hour | ~$0.04/hour |
| Aurora Serverless v2 (min 0.5 ACU × 2 instances) | Per ACU-hour | ~$0.06/hour |
| NAT Gateway | Per hour + data | ~$0.05/hour |
| ALB | Per hour | ~$0.02/hour |
| CloudFront | Per request + data | < $0.01 |
| FIS | Free | No charge |
| **Total (1-hour window)** | | **~$0.17/hour** |

## Security Considerations

- **EC2 instances require IMDSv2** (`requireImdsv2: true`) — prevents SSRF attacks via the metadata service.
- **EBS root volume encrypted** (gp3) — satisfies AwsSolutions-EC26.
- **ALB ingress restricted** to CloudFront managed prefix list — prevents direct VPC-internal access bypassing CloudFront.
- **FIS IAM role scoped by tag condition** — `ec2:TerminateInstances` and `ssm:SendCommand` are restricted to instances with `fis-target: app-instance`.
- **Aurora in isolated subnets** — no route to the internet; accessible only from within the VPC on port 5432.
- **Stop condition is mandatory** — all FIS templates include the ALB 5xx alarm stop condition.

## Troubleshooting

| Symptom | Likely cause | Resolution |
| ------- | ------------ | ---------- |
| `cdk deploy` fails with `No parameters found` | Missing `dev-params.ts` export | Verify `parameters/index.ts` exports `devParams` under the `dev` key |
| C-2/C-4 fails with `SSM agent not registered` | Instance not connected to SSM | Check IAM instance role has `AmazonSSMManagedInstanceCore`; verify SSM agent status in Fleet Manager |
| C-3 fails with `cluster does not support failover` | No reader instance | BaseStack must deploy with `readers` array containing at least one instance |
| FIS experiment stops immediately | Stop condition alarm is already in `ALARM` state | Reset the alarm: `aws cloudwatch set-alarm-state --alarm-name ... --state-value OK` |
| CloudFront returns 403 | VpcOrigin ENI not associated | Allow time for VPC Origin ENIs to be provisioned after first deploy (~5 min) |

## Clean-up

```bash
PROJECT=fis-chaos-c ENV=dev npm run stage:destroy:all
```

All resources have `removalPolicy: DESTROY`, so the destroy command removes the Aurora cluster, EC2 ASG, ALB, CloudFront distribution, VPC, FIS templates, and CloudWatch log groups completely.

## Summary

This workspace demonstrates FIS chaos engineering on a classic three-tier EC2 architecture. The four scenarios cover distinct failure modes at each layer:

- **C-1** verifies that the ASG self-heals when half the instances are suddenly terminated — validating ALB deregistration speed and CloudFront's S3 fallback.
- **C-2** verifies that the ASG scale-out policy fires under sustained CPU pressure and that new instances pass ALB health checks within the SLO window.
- **C-3** verifies that EC2 application connection pools reconnect gracefully during the ~30-second Aurora writer→reader promotion window.
- **C-4** verifies that query-timeout and circuit-breaker settings prevent ALB health checks from hanging indefinitely when the database is unreachable at the network layer.

This architecture complements Architecture B (serverless) by covering the EC2 and relational database failure domains that `aws:fis:inject-api-*` cannot reach.

## References

- [AWS FIS — Supported actions](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [AWSFIS-Run-CPU-Stress SSM document](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-ssm)
- [AWSFIS-Run-Network-Blackhole-Port SSM document](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-ssm)
- [aws:rds:failover-db-cluster action reference](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#fis-actions-reference-rds)
- [CloudFront VPC Origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html)
- [CDK aws-fis module (L1 constructs)](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_fis-readme.html)
