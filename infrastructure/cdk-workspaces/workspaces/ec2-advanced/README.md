# EC2 Advanced Patterns<!-- omit in toc -->

*Read this in other languages:* [![🇯🇵 Japanese](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-orange?style=flat-square)
![Services](https://img.shields.io/badge/Services-EC2%20%7C%20ALB%20%7C%20ASG-purple?style=flat-square)

## Table of Contents<!-- omit in toc -->

- [Introduction](#introduction)
- [Architecture Overview](#architecture-overview)
  - [Common Infrastructure](#common-infrastructure)
  - [Pattern Comparison](#pattern-comparison)
- [Prerequisites](#prerequisites)
- [Project Structure](#project-structure)
- [Pattern 1: EC2 Single Instance](#pattern-1-ec2-single-instance)
  - [Key Features](#key-features)
  - [Implementation](#implementation)
  - [When to Use](#when-to-use)
- [Pattern 2: EC2 with Auto-Recovery](#pattern-2-ec2-with-auto-recovery)
  - [Key Features](#key-features-1)
  - [Implementation](#implementation-1)
  - [How Auto-Recovery Works](#how-auto-recovery-works)
  - [When to Use](#when-to-use-1)
- [Pattern 3: Auto Scaling Group — Always 1 Instance](#pattern-3-auto-scaling-group--always-1-instance)
  - [Key Features](#key-features-2)
  - [Implementation](#implementation-2)
  - [When to Use](#when-to-use-2)
- [Pattern 4: Auto Scaling Group — Always 2 Instances (Multi-AZ)](#pattern-4-auto-scaling-group--always-2-instances-multi-az)
  - [Key Features](#key-features-3)
  - [Implementation](#implementation-3)
  - [When to Use](#when-to-use-3)
- [Security Design](#security-design)
- [nginx Sample Page](#nginx-sample-page)
- [Deploy](#deploy)
- [Connect to Instances](#connect-to-instances)
- [Clean-up](#clean-up)

## Introduction

This workspace demonstrates four EC2 deployment patterns using AWS CDK. Each pattern represents a different level of availability and operational complexity, from a simple single instance to a multi-AZ Auto Scaling Group behind an ALB.

This architecture demonstrates:

- Secure EC2 instance deployment (IMDSv2 enforced, encrypted EBS, no public IP)
- Access via SSM Session Manager (no SSH keys or Bastion hosts required)
- CloudWatch-based auto-recovery for single instance workloads
- Auto Scaling Group with ALB integration for resilient deployments
- Multi-AZ high availability with rolling update deployments
- nginx sample page displaying instance identity (hostname / instance ID / AZ)
- Shared SNS Topic for operational notifications across all patterns (StatusCheckFailed / Auto-Recovery / ASG events / CPU alarms)

## Architecture Overview

![Architecture Overview](overview.drawio.svg)

All four patterns share a common VPC stack. Each pattern stack is deployed independently.

### Common Infrastructure

- **VPC**: Custom VPC with Public and Private subnets across 2 AZs
- **NAT**: NAT Instance (t4g.nano) with scheduled start/stop for cost savings
- **Access**: SSM Session Manager (Patterns 1, 2 & 3b) or ALB HTTP (Patterns 3a & 4)
- **SNS Topic**: Shared notification topic across all patterns (configured as CloudWatch alarm action)

### Pattern Comparison

| # | Pattern | Access | Availability | Notifications | Use Case |
|---|---------|--------|--------------|---------------|----------|
| 1 | EC2 Single | SSM | Single instance | StatusCheckFailed alarm | Dev / Testing |
| 2 | EC2 Auto-Recovery | SSM | Auto-recover on HW failure | Recovery trigger / completion | Simple workloads needing HA |
| 3a | ASG Always-1 + ALB | ALB HTTP | Auto-replace on health check failure | ASG events / CPU / UnhealthyHost | Single-instance with rolling deploy |
| 3b | ASG Always-1 (SSM-only) | SSM | Auto-replace on health check failure | ASG events / CPU | Low-cost without ALB |
| 4 | ASG Always-2 Multi-AZ + ALB | ALB HTTP | AZ-level redundancy | ASG events / CPU / UnhealthyHost | Production workloads |

## Prerequisites

- AWS CLI v2 installed and configured
- Node.js 20+
- AWS CDK CLI (`npm install -g aws-cdk`)
- TypeScript basics
- AWS account with appropriate IAM permissions

## Project Structure

```text
ec2-advanced/
├── bin/
│   └── ec2-advanced.ts              # Application entry point
├── lib/
│   ├── constructs/
│   │   ├── ec2-single.ts            # Pattern 1: Single EC2 construct
│   │   ├── ec2-auto-recovery.ts     # Pattern 2: Auto-recovery construct
│   │   ├── ec2-asg-single.ts        # Pattern 3: ASG min=1/max=1 construct
│   │   ├── ec2-asg-multi.ts         # Pattern 4: ASG min=2/max=2 construct
│   │   └── index.ts                 # Re-export hub
│   ├── stacks/
│   │   ├── base-stack.ts            # Shared VPC stack
│   │   ├── ec2-single-stack.ts      # Pattern 1 stack
│   │   ├── ec2-auto-recovery-stack.ts # Pattern 2 stack
│   │   ├── ec2-asg-single-stack.ts  # Pattern 3 stack
│   │   └── ec2-asg-multi-stack.ts   # Pattern 4 stack
│   └── stages/
│       └── ec2-advanced-stage.ts    # Stage orchestration (all 6 stacks)
├── parameters/
│   ├── environments.ts              # EnvParams type definitions
│   └── dev-params.ts                # Development environment parameters
├── src/
│   └── nginx-userdata.ts            # nginx sample page user data script
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts          # CDK Nag compliance tests
│   ├── parameters/
│   │   └── test-params.ts           # Test environment parameters
│   ├── snapshot/
│   │   └── snapshot.test.ts         # Snapshot tests
│   └── unit/
│       └── ec2-advanced.test.ts     # Unit tests (39 tests)
├── cdk.json
├── package.json
└── tsconfig.json
```

## Pattern 1: EC2 Single Instance

The simplest deployment: one EC2 instance in a private subnet accessible via SSM Session Manager.

### Key Features

- No load balancer, no public IP
- IMDSv2 enforced via LaunchTemplate
- EBS root volume: GP3, encrypted
- SSM Session Manager access (no SSH key required)
- Amazon Linux 2023 (ARM64 / Graviton)
- `StatusCheckFailed` CloudWatch alarm (system + instance-level failures) → SNS notification

### Implementation

```typescript
export class Ec2Single extends Construct {
  public readonly instance: ec2.IInstance;

  constructor(scope: Construct, id: string, props: Ec2SingleProps) {
    super(scope, id);

    const instance = new ec2.Instance(this, 'Resource', {
      vpc: props.vpc,
      instanceType: props.instanceType,
      machineImage: props.machineImage,
      securityGroup: props.securityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(8, {
          encrypted: true,
          volumeType: ec2.EbsDeviceVolumeType.GP3,
        }),
      }],
      ssmSessionPermissions: true,
      requireImdsv2: true,
      userData,
    });

    // StatusCheckFailed alarm (system + instance level)
    if (props.notificationTopic) {
      const alarm = new cloudwatch.Alarm(this, 'StatusCheckAlarm', {
        metric: new cloudwatch.Metric({
          namespace: 'AWS/EC2',
          metricName: 'StatusCheckFailed',
          dimensionsMap: { InstanceId: instance.instanceId },
          statistic: 'Maximum',
          period: cdk.Duration.minutes(1),
        }),
        threshold: 1,
        evaluationPeriods: 2,
      });
      alarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
      alarm.addOkAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
    }
  }
}
```

### When to Use

- Development / testing environments
- Batch jobs or scheduled tasks that don't require high availability
- Workloads where restart time on failure is acceptable

## Pattern 2: EC2 with Auto-Recovery

Adds a CloudWatch alarm to the single instance pattern. When a system-level hardware failure is detected, AWS automatically recovers the instance (same instance ID, same private IP, same EBS volumes).

### Key Features

- Same as Pattern 1 plus CloudWatch alarm on `StatusCheckFailed_System`
- Automatic recovery within minutes of detecting a system failure
- Instance ID and private IP are preserved after recovery
- Recovery is NOT triggered by OS-level failures (only hardware/hypervisor issues)
- SNS notification on recovery trigger and recovery completion

### Implementation

```typescript
// CloudWatch alarm for system status check failure
const alarm = new cloudwatch.Alarm(this, 'SystemStatusAlarm', {
  metric: new cloudwatch.Metric({
    namespace: 'AWS/EC2',
    metricName: 'StatusCheckFailed_System',
    dimensionsMap: { InstanceId: instance.instanceId },
    period: cdk.Duration.minutes(1),
    statistic: 'Maximum',
  }),
  evaluationPeriods: props.recoveryEvaluationPeriods ?? 2,
  threshold: 1,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});

// Trigger EC2 auto-recovery action
alarm.addAlarmAction(
  new cloudwatch_actions.Ec2Action(cloudwatch_actions.Ec2InstanceAction.RECOVER)
);
// SNS notification on recovery trigger and completion
if (props.notificationTopic) {
  alarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
  alarm.addOkAction(new cloudwatch_actions.SnsAction(props.notificationTopic));
}
```

### How Auto-Recovery Works

```text
System status check failure detected
  └─ CloudWatch alarm enters ALARM state (after 2 consecutive 1-min periods)
       └─ EC2 Auto-Recovery action triggered
            └─ Instance migrated to healthy host
                 └─ Same instance ID / private IP / EBS volumes preserved
```

> ⚠️ Auto-recovery is not supported on instances with instance store volumes.

### When to Use

- Single-instance workloads that need resilience against hardware failures
- Situations where the same private IP address must be preserved
- Cost-effective HA for non-critical services

## Pattern 3: Auto Scaling Group — Always 1 Instance

An ASG with `min=1 / desired=1 / max=1` that automatically replaces the instance when it becomes unhealthy. The `Ec2AsgSingle` construct supports two sub-modes depending on whether a `listener` is provided.

### Sub-mode A: With ALB

Instances are registered as targets behind an Application Load Balancer.

**Key Features:**
- ALB for HTTP access (port 80 by default)
- IMDSv2 enforced via LaunchTemplate
- Rolling update: replaces the instance without downtime during CDK redeploy
- Health check on both EC2 and ALB levels
- ASG scaling event notifications (launch / terminate / error) → SNS
- ALB UnhealthyHost alarm → SNS
- CPU utilization alarm (≥80% / recovery) → SNS

```typescript
const asg = new autoscaling.AutoScalingGroup(this, 'Resource', {
  vpc: props.vpc,
  launchTemplate,
  minCapacity: 1,
  maxCapacity: 1,
  desiredCapacity: 1,
  healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
    additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
    gracePeriod: Duration.seconds(60),
  }),
  updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
  notifications: props.notificationTopic
    ? [{ topic: props.notificationTopic, scalingEvents: autoscaling.ScalingEvents.ALL }]
    : undefined,
});

// Register ASG as ALB target (when listener is provided)
props.listener.addTargets('AsgTargets', {
  port: props.instancePort ?? 80,
  targets: [asg],
  healthCheck: { path: props.healthCheckPath ?? '/' },
});
```

**When to Use:**
- Applications that need HTTP access through a load balancer
- Rolling deployments without SSH key management
- Pre-production and staging environments

### Sub-mode B: Without ALB (SSM-only)

No load balancer is created. Instances are accessible via SSM Session Manager only. The ASG uses EC2 instance health checks and replaces the instance on failure.

**Key Features:**
- No ALB, no public IP — SSM Session Manager access only
- IMDSv2 enforced via LaunchTemplate
- EC2 health check (replaces on instance-level failure, not just hardware)
- Lower cost than Sub-mode A (no ALB charge)
- Unlike auto-recovery (Pattern 2), the replacement instance gets a **new** instance ID and private IP
- ASG scaling event notifications → SNS
- CPU utilization alarm (≥80% / recovery) → SNS

```typescript
const asg = new autoscaling.AutoScalingGroup(this, 'Resource', {
  vpc: props.vpc,
  launchTemplate,
  minCapacity: 1,
  maxCapacity: 1,
  desiredCapacity: 1,
  healthChecks: autoscaling.HealthChecks.ec2({ gracePeriod: Duration.seconds(60) }),
  updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
  notifications: props.notificationTopic
    ? [{ topic: props.notificationTopic, scalingEvents: autoscaling.ScalingEvents.ALL }]
    : undefined,
});
// No listener.addTargets() call — SSM-only access
```

**When to Use:**
- Workloads that need automatic replacement on OS-level failures (not just hardware)
- Services where the private IP can change after replacement
- Cost-sensitive environments where ALB is unnecessary

### Pattern 2 vs Pattern 3 (no ALB) Comparison

| Item | Pattern 2: Auto-Recovery | Pattern 3 (no ALB): ASG |
|------|--------------------------|-------------------------|
| Recovery mechanism | Recovers same instance in-place | Terminates → launches new instance |
| Instance ID after recovery | **Same** | **Changes** |
| Private IP after recovery | **Same** | **Changes** |
| Failure types handled | Hardware / hypervisor only | Hardware + OS-level failures |
| ALB | Not needed | Not needed |
| Recovery speed | Minutes (in-place) | Slower (new instance launch) |

## Pattern 4: Auto Scaling Group — Always 2 Instances (Multi-AZ)

Extends Pattern 3 with `min=2 / desired=2 / max=2` instances distributed across multiple Availability Zones. If one AZ fails, the remaining instance continues serving traffic.

### Key Features

- 2 instances across 2 AZs (AZ-level redundancy)
- ALB health checks with automatic instance replacement
- Rolling update with `minInstancesInService: 1` (zero downtime during deploy)
- Configurable `minCapacity` / `maxCapacity` props
- ASG scaling event notifications (launch / terminate / error) → SNS
- ALB UnhealthyHost alarm → SNS
- CPU utilization alarm (≥80% / recovery) → SNS

### Implementation

```typescript
const asg = new autoscaling.AutoScalingGroup(this, 'Resource', {
  vpc: props.vpc,
  launchTemplate,
  minCapacity: props.minCapacity ?? 2,
  maxCapacity: props.maxCapacity ?? 2,
  desiredCapacity: props.minCapacity ?? 2,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
    additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
    gracePeriod: cdk.Duration.seconds(60),
  }),
  updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
    minInstancesInService: 1,  // Keep at least 1 instance during rolling update
  }),
  notifications: props.notificationTopic
    ? [{ topic: props.notificationTopic, scalingEvents: autoscaling.ScalingEvents.ALL }]
    : undefined,
});
```

### When to Use

- Production workloads requiring AZ-level redundancy
- Applications that need zero-downtime deployments
- Services where one AZ failure must not cause an outage

## Security Design

All patterns follow these security best practices:

| Control | Implementation |
|---------|----------------|
| IMDSv2 enforced | `requireImdsv2: true` via LaunchTemplate |
| No SSH keys | SSM Session Manager (`ssmSessionPermissions: true`) |
| No public IP | Instances in private subnets only |
| Encrypted EBS | GP3 root volume with `encrypted: true` |
| Minimal security groups | EC2 SG: outbound only; ALB SG: HTTP from allowed IPs |
| ALB IP restriction | `allowedIpsforAlb` prop limits HTTP access by source CIDR |

## Operational Monitoring

All patterns share a single SNS Topic (created in `BaseStack`) as the CloudWatch alarm target.

| Pattern | Alarm / Event | Notification trigger |
|---------|---------------|---------------------|
| 1: EC2 Single | `StatusCheckFailed` (system + instance) | Failure detected / recovered |
| 2: Auto-Recovery | `StatusCheckFailed_System` + EC2 Recover | Recovery triggered / completed |
| 3a/3b/4: ASG | ASG scaling events (ALL) | Instance launch / terminate / error |
| 3a/4: ASG + ALB | ALB `UnhealthyHostCount` ≥ 1 | Unhealthy instance / recovered |
| 3a/3b/4: ASG | `CPUUtilization` ≥ 80% (5-min avg × 3 periods) | High CPU / recovered |

Add SNS subscriptions (Email, Slack, etc.) to the `notificationTopic` in `BaseStack`.

## nginx Sample Page

All instances run nginx with a sample HTML page that displays the instance identity. The page is configured via EC2 User Data at launch:

1. Install nginx (`dnf install -y nginx` on Amazon Linux 2023)
2. Fetch IMDSv2 token
3. Retrieve `instance-id`, `placement/availability-zone`, and `hostname` from instance metadata
4. Write an HTML page with the instance information
5. Start and enable nginx

The result: each instance serves a page showing its own **Hostname**, **Instance ID**, and **Availability Zone**. With the ALB patterns (3 & 4), refreshing the page may show different instances.

## Deploy

```bash
# Install dependencies (from workspace root)
cd infrastructure/cdk-workspaces
npm install

# Navigate to this workspace
cd workspaces/ec2-advanced

# Bootstrap (first time only)
npx cdk bootstrap --context project=myproject --context env=dev

# Synthesize
npx cdk synth --context project=myproject --context env=dev

# Deploy all stacks
npx cdk deploy --all --context project=myproject --context env=dev
```

> The `allowedIpsforAlb` parameter is automatically set to your current global IP via `getMyGlobalIpCidr()` in `bin/ec2-advanced.ts`.

## Connect to Instances

**Patterns 1 & 2 (SSM Session Manager):**

```bash
# Get instance ID from CloudFormation output
aws cloudformation describe-stacks \
  --stack-name DevMyprojectSingle \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text

# Start SSM session
aws ssm start-session --target <instance-id>
```

**Patterns 3 & 4 (ALB):**

```bash
# Get ALB DNS name from CloudFormation output
aws cloudformation describe-stacks \
  --stack-name DevMyprojectAsgSingle \
  --query 'Stacks[0].Outputs[?OutputKey==`AlbDnsName`].OutputValue' \
  --output text

# Open in browser
curl http://<alb-dns-name>/
```

## Clean-up

```bash
# Destroy all stacks
npx cdk destroy --all --context project=myproject --context env=dev
```

> ⚠️ Deleting the stacks removes all EC2 instances and the VPC. There is no data stored in this architecture, so no data loss occurs.