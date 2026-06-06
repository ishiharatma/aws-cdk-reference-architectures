# VPC with NAT Instance v2<!-- omit in toc -->

*Read this in other languages:* [![🇯🇵 Japanese](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-orange?style=flat-square)
![Services](https://img.shields.io/badge/Services-VPC-purple?style=flat-square)

## Table of Contents<!-- omit in toc -->

- [Introduction](#introduction)
- [Architecture Overview](#architecture-overview)
  - [Key Changes](#key-changes)
- [Prerequisites](#prerequisites)
- [NAT Instance v2 Implementation](#nat-instance-v2-implementation)
  - [1. Creating NAT Provider](#1-creating-nat-provider)
    - [Why t4g.nano?](#why-t4gnano)
  - [2. Allowing Traffic from VPC to NAT Instance](#2-allowing-traffic-from-vpc-to-nat-instance)
- [Automated Start/Stop with EventBridge](#automated-startstop-with-eventbridge)
  - [1. Creating IAM Role](#1-creating-iam-role)
  - [2. Creating Schedule Rules](#2-creating-schedule-rules)
    - [Understanding Cron Expressions](#understanding-cron-expressions)
- [Static Elastic IP Assignment](#static-elastic-ip-assignment)
  - [Why Static IP is Needed?](#why-static-ip-is-needed)
- [Monitoring NAT Instance State Changes](#monitoring-nat-instance-state-changes)
  - [1. Creating SNS Topic](#1-creating-sns-topic)
  - [2. Creating EventBridge Rule](#2-creating-eventbridge-rule)
  - [3. Setting Up Email Notifications (Optional)](#3-setting-up-email-notifications-optional)
    - [Notified Events](#notified-events)
- [NAT Gateway vs NAT Instance: Trade-offs](#nat-gateway-vs-nat-instance-trade-offs)
  - [Feature Comparison Table](#feature-comparison-table)
  - [Recommended Use Cases](#recommended-use-cases)
    - [Use Cases for NAT Gateway](#use-cases-for-nat-gateway)
    - [Use Cases for NAT Instance](#use-cases-for-nat-instance)
  - [Performance Comparison](#performance-comparison)
- [Cost Analysis](#cost-analysis)
  - [Detailed Cost Comparison (Tokyo Region)](#detailed-cost-comparison-tokyo-region)
    - [1. NAT Gateway (Traditional)](#1-nat-gateway-traditional)
    - [2. NAT Instance (t4g.nano) - 24/7 Operation](#2-nat-instance-t4gnano---247-operation)
    - [3. NAT Instance - Business Hours Only (Weekdays 9 hours)](#3-nat-instance---business-hours-only-weekdays-9-hours)
  - [Recommended Configuration and Costs by Environment](#recommended-configuration-and-costs-by-environment)
- [Automating Patch Application](#automating-patch-application)
  - [1. Granting SSM Permissions to NAT Instance](#1-granting-ssm-permissions-to-nat-instance)
  - [2. Creating Patch Baseline](#2-creating-patch-baseline)
  - [3. Configuring Maintenance Window](#3-configuring-maintenance-window)
    - [3.1. IAM Role for Maintenance Window](#31-iam-role-for-maintenance-window)
    - [3.2. Creating Maintenance Window](#32-creating-maintenance-window)
    - [3.3. Configuring Patch Task](#33-configuring-patch-task)
  - [5. Monitoring Patch Application Status](#5-monitoring-patch-application-status)
  - [Key Points for Patch Management](#key-points-for-patch-management)
  - [Patch Application Flow](#patch-application-flow)
- [Best Practices](#best-practices)
  - [1. Security](#1-security)
  - [2. Monitoring and Alerts](#2-monitoring-and-alerts)
  - [3. Optimal Availability for Development Environments](#3-optimal-availability-for-development-environments)
- [Troubleshooting](#troubleshooting)
  - [Common Issues and Solutions](#common-issues-and-solutions)
    - [1. Cannot Access Internet from Private Subnet After NAT Instance Stops](#1-cannot-access-internet-from-private-subnet-after-nat-instance-stops)
    - [2. Instance Not Showing in Systems Manager](#2-instance-not-showing-in-systems-manager)
    - [3. Patch Application Fails](#3-patch-application-fails)
    - [4. Poor Performance](#4-poor-performance)
    - [5. Unexpected Shutdown](#5-unexpected-shutdown)
  - [Troubleshooting Tips](#troubleshooting-tips)
- [Deployment and Cleanup](#deployment-and-cleanup)
  - [Deployment](#deployment)
  - [Cleanup](#cleanup)
- [Summary](#summary)
  - [Recommendations](#recommendations)
- [Reference Links](#reference-links)

## Introduction

This architecture demonstrates the following implementations:

- NAT Instance v2 implementation method
- Automated start/stop scheduling with EventBridge
- Static Elastic IP assignment to NAT Instance
- Monitoring NAT Instance state changes and SNS notifications
- Automated patch application using Systems Manager Patch Manager
- Maintenance window configuration and operations
- Trade-offs between NAT Gateway and NAT Instance

## Architecture Overview

![Architecture Overview](overview.drawio.svg)

The basic VPC configuration is the same as [vpc-basics](https://github.com/ishiharatma/aws-cdk-reference-architectures/tree/main/infrastructure/cdk-workspaces/workspaces/vpc-basics), with the following differences.

### Key Changes

1. NAT Gateway → NAT Instance: Changed from managed NAT service to EC2-based NAT instance
2. EventBridge Schedule: Automated start/stop schedule configuration
3. Elastic IP Assignment: Assigned static IP address to NAT Instance
4. SNS Notification: Monitoring NAT Instance state changes
5. Patch Manager: Automated patch application via Systems Manager

## Prerequisites

In addition to the prerequisites of [vpc-basics](https://github.com/ishiharatma/aws-cdk-reference-architectures/tree/main/infrastructure/cdk-workspaces/workspaces/vpc-basics), the following are required:

- Basic understanding of EventBridge and SNS
- Knowledge of EC2 instance types

## NAT Instance v2 Implementation

### 1. Creating NAT Provider

In CDK v2, you can easily create a NAT instance using `NatProvider.instanceV2()`.

```typescript
import * as ec2 from 'aws-cdk-lib/aws-ec2';

// Creating NAT Instance Provider
const natProvider = ec2.NatProvider.instanceV2({
  instanceType: ec2.InstanceType.of(
    ec2.InstanceClass.T4G,  // ARM-based Graviton2
    ec2.InstanceSize.NANO   // Smallest size for cost optimization
  ),
  machineImage: ec2.MachineImage.latestAmazonLinux2023({
    edition: ec2.AmazonLinuxEdition.STANDARD,
    cpuType: ec2.AmazonLinuxCpuType.ARM_64,  // For Graviton2
  }),
  defaultAllowedTraffic: ec2.NatTrafficDirection.OUTBOUND_ONLY,
});

// Applying NAT Provider to VPC
const vpc = new ec2.Vpc(this, 'VpcNatInstanceV2', {
  vpcName,
  ipAddresses: ec2.IpAddresses.cidr('10.1.0.0/16'),
  maxAzs: 3,
  natGateways: 3,  // One per AZ
  natGatewayProvider: natProvider,  // Using NAT Instance
  subnetConfiguration: [
    // Subnet configuration same as before
    // ...
  ],
});
```

#### Why t4g.nano?

※ Tokyo Region pricing

| Instance Type | vCPU | Memory | Price/hour (Tokyo) | Monthly | Use Case |
|---------------|------|--------|-------------------|---------|----------|
| t4g.nano | 2 | 0.5 GB | $0.0054 | ~$3.94 | Small traffic for development environments |
| t4g.micro | 2 | 1 GB | $0.0108 | ~$7.88 | Medium traffic |
| t3.nano | 2 | 0.5 GB | $0.0068 | ~$4.96 | When x86 is required |

💡 Benefits of Graviton2 (ARM):

- Approximately 20% cheaper than equivalent x86 instances
- Superior cost-performance ratio
- Fully supported by Amazon Linux 2023

### 2. Allowing Traffic from VPC to NAT Instance

NAT Instance needs to accept all traffic from within the VPC.

```typescript
// Allow all traffic from VPC CIDR
(natProvider as ec2.NatInstanceProviderV2).connections.allowFrom(
  ec2.Peer.ipv4(vpc.vpcCidrBlock),
  ec2.Port.allTraffic(),
  'Allow all traffic from VPC',
);
```

This allows resources in private subnets to access the internet via NAT Instance.

## Automated Start/Stop with EventBridge

You can further reduce costs by stopping NAT Instance outside business hours.

### 1. Creating IAM Role

```typescript
import * as iam from 'aws-cdk-lib/aws-iam';

const natInstanceScheduleRole = new iam.Role(this, 'NatInstanceScheduleRole', {
  roleName: [props.project, props.environment, 'NatInstanceSchedule'].join('-'),
  assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
  managedPolicies: [
    iam.ManagedPolicy.fromAwsManagedPolicyName(
      'service-role/AmazonSSMAutomationRole'
    ),
  ],
});
```

### 2. Creating Schedule Rules

```typescript
import * as events from 'aws-cdk-lib/aws-events';

const region = cdk.Stack.of(this).region;

// Schedule configuration (UTC time)
const startCronSchedule = 'cron(0 0 ? * * *)'; // 00:00 UTC (JST 09:00)
const stopCronSchedule = 'cron(0 9 ? * * *)';  // 09:00 UTC (JST 18:00)

const natInstanceIds: string[] = [];

natProvider.configuredGateways.forEach((nat, index) => {
  natInstanceIds.push(nat.gatewayId);
  
  // Start schedule
  new events.CfnRule(this, `EC2StartRule${index + 1}`, {
    name: [props.project, props.environment, 'NATStartRule', nat.gatewayId].join('-'),
    description: `${nat.gatewayId} ${startCronSchedule} Start`,
    scheduleExpression: startCronSchedule,
    targets: [{
      arn: `arn:aws:ssm:${region}::automation-definition/AWS-StartEC2Instance:$DEFAULT`,
      id: 'TargetEC2Instance1',
      input: `{"InstanceId": ["${nat.gatewayId}"]}`,
      roleArn: natInstanceScheduleRole.roleArn,
    }],
  });

  // Stop schedule
  new events.CfnRule(this, `EC2StopRule${index + 1}`, {
    name: [props.project, props.environment, 'NATStopRule', nat.gatewayId].join('-'),
    description: `${nat.gatewayId} ${stopCronSchedule} Stop`,
    scheduleExpression: stopCronSchedule,
    targets: [{
      arn: `arn:aws:ssm:${region}::automation-definition/AWS-StopEC2Instance:$DEFAULT`,
      id: 'TargetEC2Instance1',
      input: `{"InstanceId": ["${nat.gatewayId}"]}`,
      roleArn: natInstanceScheduleRole.roleArn,
    }],
  });
});
```

#### Understanding Cron Expressions

```text
cron(minute hour day month day-of-week year)

Examples:
cron(0 0 ? * * *)     # Every day at 00:00 UTC
cron(0 9 ? * * *)     # Every day at 09:00 UTC
cron(0 0 ? * MON-FRI *) # Weekdays only at 00:00 UTC
cron(0 0 1 * ? *)     # 1st day of every month at 00:00 UTC
```

💡 Time Zone Notes:

- EventBridge cron uses UTC time
- JST = UTC + 9 hours
- JST 09:00 = UTC 00:00
- JST 18:00 = UTC 09:00

Schedule examples by environment:

| Environment | Operating Hours (JST) | Start (UTC) | Stop (UTC) | Monthly Cost |
|------------|----------------------|-------------|-----------|--------------|
| Development | Weekdays 9:00-18:00 | `cron(0 0 ? * MON-FRI *)` | `cron(0 9 ? * MON-FRI *)` | ~$1.07 (t4g.nano) |
| Test | Daily 9:00-18:00 | `cron(0 0 ? * * *)` | `cron(0 9 ? * * *)` | ~$3.89 (t4g.nano) |
| Staging | 24/7 | Recommend NAT Gateway same as production | Recommend NAT Gateway same as production | ~$44.64 |
| Production | 24/7 | Recommend NAT Gateway | Recommend NAT Gateway | ~$44.64 |

## Static Elastic IP Assignment

By assigning a static Elastic IP to NAT Instance, you can fix the source IP address for outbound communications.

```typescript
const outboundEips: ec2.CfnEIP[] = [];

natProvider.configuredGateways.forEach((nat, index) => {
  // Creating Elastic IP
  const eip = new ec2.CfnEIP(this, `NatEip${index + 1}`, {
    tags: [{
      key: "Name",
      value: `${props.project}/${props.environment}/NatEIP${index + 1}`
    }],
  });
  eip.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

  // Associate Elastic IP with NAT Instance
  new ec2.CfnEIPAssociation(this, `NatEipAssociation${index + 1}`, {
    allocationId: eip.attrAllocationId,
    instanceId: nat.gatewayId,
  });

  // Output as CloudFormation Output
  new cdk.CfnOutput(this, `NatInstance${index + 1}PublicIP`, {
    value: eip.ref,
    description: `Public IP address of NAT Instance ${index + 1}`,
  });

  outboundEips.push(eip);
});
```

### Why Static IP is Needed?

1. **External Service Whitelisting**
   - Many third-party APIs require IP whitelisting
   - Database access control via security groups
   - VPN connection configurations

2. **Log Analysis and Troubleshooting**
   - Tracking outbound traffic with fixed source IP
   - Easier identification of access source

3. **Compliance Requirements**
   - Some industries require tracking of outbound communication sources
   - Auditing and logging requirements

## Monitoring NAT Instance State Changes

Set up SNS notifications to receive alerts when NAT Instance state changes.

### 1. Creating SNS Topic

```typescript
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';

// Create SNS Topic
const natInstanceTopic = new sns.Topic(this, 'NatInstanceTopic', {
  topicName: [props.project, props.environment, 'NatInstance'].join('-'),
  displayName: 'NAT Instance State Change Notifications',
});

// Email subscription (optional)
if (props.notificationEmail) {
  natInstanceTopic.addSubscription(
    new subscriptions.EmailSubscription(props.notificationEmail)
  );
}
```

### 2. Creating EventBridge Rule

```typescript
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

// Rule for NAT Instance state change
const natInstanceStateRule = new events.Rule(this, 'NatInstanceStateRule', {
  ruleName: [props.project, props.environment, 'NatInstanceState'].join('-'),
  description: 'Notify when NAT Instance state changes',
  eventPattern: {
    source: ['aws.ec2'],
    detailType: ['EC2 Instance State-change Notification'],
    detail: {
      'instance-id': natInstanceIds,
      'state': ['pending', 'running', 'stopping', 'stopped', 'terminated'],
    },
  },
});

// Add SNS topic as target
natInstanceStateRule.addTarget(new targets.SnsTopic(natInstanceTopic, {
  message: events.RuleTargetInput.fromObject({
    subject: `[${props.project.toUpperCase()}-${props.environment.toUpperCase()}] NAT Instance State Change`,
    instanceId: events.EventField.fromPath('$.detail.instance-id'),
    state: events.EventField.fromPath('$.detail.state'),
    time: events.EventField.fromPath('$.time'),
  }),
}));
```

### 3. Setting Up Email Notifications (Optional)

When an email address is provided, you'll receive notifications like:

```json
{
  "subject": "[YOURPROJECT-DEV] NAT Instance State Change",
  "instanceId": "i-0123456789abcdef0",
  "state": "running",
  "time": "2024-01-15T12:00:00Z"
}
```

#### Notified Events

- `pending`: Instance is starting
- `running`: Instance is running
- `stopping`: Instance is stopping
- `stopped`: Instance is stopped
- `terminated`: Instance is terminated

💡 **Tips**:

- Set up Slack/Teams integration via SNS for team notifications
- Log important events to CloudWatch Logs
- Create dashboards combining CloudWatch metrics

## NAT Gateway vs NAT Instance: Trade-offs

### Feature Comparison Table

| Feature | NAT Gateway | NAT Instance |
|---------|-------------|-------------|
| **Availability** | ✅ Managed by AWS | Depends on instance type |
| **Performance** | ✅ Up to 100 Gbps | Depends on instance type |
| **Cost (24/7)** | ~$44.64/month | ✅ ~$3.94/month (t4g.nano) |
| **Scheduled Control** | ❌ Not available | ✅ EventBridge schedule |
| **Patch Management** | ✅ Not required (Managed) | Required (SSM Patch Manager) |
| **Scalability** | ✅ Automatic |  Manual (instance type change) |
| **Monitoring** | CloudWatch metrics | CloudWatch + OS metrics |
| **Single Point of Failure** | ✅ No | Yes (single instance) |

### Recommended Use Cases

#### Use Cases for NAT Gateway

1. **Production Environments**
   - 24/7 operation required
   - High availability is critical
   - Handling large traffic volume

2. **High Performance Requirements**
   - Burst traffic handling needed
   - Bandwidth requirements over 5 Gbps
   - Multiple concurrent connections

3. **Zero Operational Overhead**
   - No infrastructure management desired
   - Fully managed service preferred
   - No patching management needed

#### Use Cases for NAT Instance

1. **Development/Test Environments**
   - Traffic only during business hours
   - Cost optimization prioritized
   - Downtime acceptable

2. **Cost Reduction Priority**
   - Small-scale traffic
   - Scheduled operation possible
   - Operational overhead acceptable

3. **Custom Network Control**
   - Custom security groups needed
   - Traffic filtering required
   - Specific logging requirements

### Performance Comparison

| Metric | NAT Gateway | NAT Instance (t4g.nano) | NAT Instance (t4g.micro) |
|--------|-------------|------------------------|-------------------------|
| **Bandwidth** | Up to 100 Gbps | Up to 5 Gbps | Up to 5 Gbps |
| **Max Connections** | 55,000~440,000 | ~55,000 | ~55,000 |
| **Bandwidth** | 10 Gbps | ~ 5 Gbps | ~ 5 Gbps |
| **Latency** | Low | Low | Low |

💡 **Tips**: For development environments with low traffic, t4g.nano is sufficient. For production use, consider t4g.medium or larger.

## Cost Analysis

### Detailed Cost Comparison (Tokyo Region)

#### 1. NAT Gateway (Traditional)

```text
Base Charge:
- $0.062/hour × 730 hours = $45.26/month

Data Processing:
- $0.062/GB
- Example: 100 GB/month = $6.20

Total: ~$51.46/month per AZ
3 AZs: ~$154.38/month
```

#### 2. NAT Instance (t4g.nano) - 24/7 Operation

```text
Instance Charge:
- $0.0054/hour × 730 hours = $3.94/month

Elastic IP:
- While stopped: $0.005/hour × 730 hours = $3.65/month

Data Transfer:
- Same as NAT Gateway ($0.062/GB)
- Example: 100 GB/month = $6.20

Total: ~$13.79/month per instance
3 instances: ~$41.37/month

Savings: $154.38 - $41.37 = $113.01/month (73% reduction)
Annual savings: ~$1,356
```

#### 3. NAT Instance - Business Hours Only (Weekdays 9 hours)

```text
Instance Charge:
- Operating hours: 9 hours × 5 days × 4.33 weeks = ~195 hours/month
- $0.0054/hour × 195 hours = $1.05/month

Elastic IP:
- While stopped: $0.005/hour × 730 hours = $3.65/month

Data Transfer:
- Same as NAT Gateway ($0.062/GB)
- Example: 100 GB/month = $6.20

Total: ~$10.9/month per instance
3 instances: ~$32.7/month
Savings: $154.38 - $32.7 = $121.68/month (79% reduction)
Annual savings: ~$1,460
```

💡 **Important Note**: For scheduled operation, also calculate Elastic IP charges during stop periods. In many cases, 24/7 operation may be more cost-effective.

### Recommended Configuration and Costs by Environment

| Environment | Configuration | Monthly Cost | Reasoning |
|------------|--------------|--------------|-----------|
| **Development** | NAT Instance × 1 (t4g.nano, 9/7) | ~$1.84 | Cost priority, downtime acceptable |
| **Test** | NAT Instance × 1 (t4g.micro, 9/7) | ~$1.84 | Cost and performance balance |
| **Staging** | NAT Gateway × 1 | ~$44.64 | Production equivalent |
| **Production** | NAT Gateway × 3 | ~$154 | High availability critical |

## Automating Patch Application

Use Systems Manager Patch Manager to automatically apply security patches to NAT Instance.

### 1. Granting SSM Permissions to NAT Instance

NAT Instance requires permissions to use Systems Manager.

```typescript
import * as iam from 'aws-cdk-lib/aws-iam';

// Add SSM managed policy to NAT Instance role
(natProvider as ec2.NatInstanceProviderV2).connections.allowFrom(
  ec2.Peer.ipv4(vpc.vpcCidrBlock),
  ec2.Port.allTraffic(),
  'Allow all traffic from VPC',
);

// Get NAT Instance role
const natInstanceRole = (natProvider as ec2.NatInstanceProviderV2).securityGroup.node.tryFindChild('InstanceRole') as iam.Role;

// Add SSM managed policy
natInstanceRole.addManagedPolicy(
  iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
);
```

This allows NAT Instance to:

- Report to Systems Manager Fleet Manager
- Execute commands via Session Manager
- Execute Patch Manager tasks

### 2. Creating Patch Baseline

```typescript
import * as ssm from 'aws-cdk-lib/aws-ssm';

// Create patch baseline for Amazon Linux 2023
const patchBaseline = new ssm.CfnPatchBaseline(this, 'NatInstancePatchBaseline', {
  name: `${props.project}-${props.environment}-AL2023-PatchBaseline`,
  description: 'Patch baseline for NAT Instance (Amazon Linux 2023)',
  operatingSystem: 'AMAZON_LINUX_2023',
  approvalRules: {
    patchRules: [
      {
        // Security patches
        patchFilterGroup: {
          patchFilters: [
            {
              key: 'CLASSIFICATION',
              values: ['Security', 'Bugfix'],
            },
            {
              key: 'SEVERITY',
              values: ['Critical', 'Important'],
            },
          ],
        },
        approveAfterDays: 7,  // Apply 7 days after release
        complianceLevel: 'HIGH',
        enableNonSecurity: false,
      },
    ],
  },
  // Tag-based target specification
  patchGroups: [`/NatInstance/${props.project}/${props.environment}`],
});
```

💡 **Key Points**:

- `approveAfterDays: 7`: Apply only tested patches
- `SEVERITY: Critical, Important`: Apply high-priority patches first

### 3. Configuring Maintenance Window

#### 3.1. IAM Role for Maintenance Window

```typescript
const maintenanceWindowRole = new iam.Role(this, 'MaintenanceWindowRole', {
  roleName: `${props.project}-${props.environment}-MaintenanceWindowRole`,
  assumedBy: new iam.CompositePrincipal(
    new iam.ServicePrincipal('ssm.amazonaws.com'),
    new iam.ServicePrincipal('ec2.amazonaws.com'),
  ),
  managedPolicies: [
    iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonSSMMaintenanceWindowRole'),
    iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
  ],
});

// Add PassRole permission
maintenanceWindowRole.addToPolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['iam:PassRole'],
  resources: [natInstanceRole.roleArn],
  conditions: {
    StringEquals: {
      'iam:PassedToService': 'ssm.amazonaws.com',
    },
  },
}));
```

#### 3.2. Creating Maintenance Window

```typescript
// Maintenance window: Every Sunday 12:00 JST (03:00 UTC)
const maintenanceWindow = new ssm.CfnMaintenanceWindow(this, 'NatInstanceMaintenanceWindow', {
  name: `${props.project}-${props.environment}-NatInstance-PatchWindow`,
  description: 'Weekly maintenance window for NAT Instance patches',
  schedule: 'cron(0 3 ? * SUN *)',  // Every Sunday 03:00 UTC (12:00 JST)
  duration: 4,  // 4 hours
  cutoff: 1,    // Stop 1 hour before end
  allowUnassociatedTargets: false,
  scheduleTimezone: 'UTC',
});
```

#### 3.3. Configuring Patch Task

```typescript
// Maintenance window target
const maintenanceWindowTarget = new ssm.CfnMaintenanceWindowTarget(this, 'NatInstanceTarget', {
  windowId: maintenanceWindow.ref,
  resourceType: 'INSTANCE',
  targets: [
    {
      key: 'tag:Patch Group',
      values: [`/NatInstance/${props.project}/${props.environment}`],
    },
  ],
});

// Patch task
new ssm.CfnMaintenanceWindowTask(this, 'PatchTask', {
  windowId: maintenanceWindow.ref,
  taskType: 'RUN_COMMAND',
  taskArn: 'AWS-RunPatchBaseline',
  targets: [
    {
      key: 'WindowTargetIds',
      values: [maintenanceWindowTarget.ref],
    },
  ],
  serviceRoleArn: maintenanceWindowRole.roleArn,
  priority: 1,
  maxConcurrency: '1',  // Sequential execution one at a time
  maxErrors: '1',
  taskInvocationParameters: {
    maintenanceWindowRunCommandParameters: {
      parameters: {
        Operation: ['Install'],
        RebootOption: ['RebootIfNeeded'],
      },
      timeoutSeconds: 3600,  // 1 hour timeout
      cloudWatchOutputConfig: {
        cloudWatchLogGroupName: `/aws/ssm/${props.project}/${props.environment}/patch`,
        cloudWatchOutputEnabled: true,
      },
    },
  },
});
```

💡 **Important Parameters**:

- `maxConcurrency: '1'`: Apply sequentially one instance at a time (maintain availability)
- `RebootOption: 'RebootIfNeeded'`: Auto-reboot when kernel patch requires it
- `timeoutSeconds: 3600`: Allow sufficient time for patch application

### 5. Monitoring Patch Application Status

```typescript
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';

// SNS topic for patch notifications
const patchNotificationTopic = new sns.Topic(this, 'PatchNotificationTopic', {
  topicName: `${props.project}-${props.environment}-PatchNotification`,
  displayName: 'NAT Instance Patch Status Notifications',
});

// Email subscription (optional)
if (props.notificationEmail) {
  patchNotificationTopic.addSubscription(
    new subscriptions.EmailSubscription(props.notificationEmail)
  );
}

// EventBridge rule for patch completion
const patchCompletionRule = new events.Rule(this, 'PatchCompletionRule', {
  ruleName: `${props.project}-${props.environment}-NatInstancePatchCompletion`,
  description: 'Notify when NAT Instance patch completes',
  eventPattern: {
    source: ['aws.ssm'],
    detailType: ['EC2 Command Status-change Notification'],
    detail: {
      'status': ['Success', 'Failed', 'TimedOut'],
      'document-name': ['AWS-RunPatchBaseline'],
    },
  },
});

patchCompletionRule.addTarget(new targets.SnsTopic(patchNotificationTopic, {
  message: events.RuleTargetInput.fromObject({
    default: events.EventField.fromPath('$.detail'),
    subject: `[${props.project.toUpperCase()}-${props.environment.toUpperCase()}] NAT Instance Patch Status`,
    message: {
      summary: `Patch operation ${events.EventField.fromPath('$.detail.status')}`,
      details: {
        commandId: events.EventField.fromPath('$.detail.command-id'),
        instanceId: events.EventField.fromPath('$.detail.instance-id'),
        status: events.EventField.fromPath('$.detail.status'),
        documentName: events.EventField.fromPath('$.detail.document-name'),
      },
    },
  }),
}));

// Compliance violation alarm
const complianceMetric = new cloudwatch.Metric({
  namespace: 'AWS/SSM',
  metricName: 'PatchComplianceNonCompliantCount',
  dimensionsMap: {
    PatchGroup: `/NatInstance/${props.project}/${props.environment}`,
  },
  statistic: 'Average',
  period: cdk.Duration.hours(1),
});

new cloudwatch.Alarm(this, 'PatchComplianceAlarm', {
  alarmName: `${props.project}-${props.environment}-NatInstancePatchNonCompliant`,
  metric: complianceMetric,
  threshold: 0,
  evaluationPeriods: 2,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
}).addAlarmAction(new cloudwatchActions.SnsAction(patchNotificationTopic));
```

### Key Points for Patch Management

| Item | Setting | Reason |
|------|---------|--------|
| Execution Timing | Every Sunday 3:00 UTC (12:00 JST) | Low traffic period |
| Window Duration | 4 hours | Accommodate sequential application to multiple instances |
| Concurrency | 1 instance | Sequential execution to maintain availability |
| Reboot | As needed | For kernel patches etc. |
| Approval Period | 7 days | Apply only tested patches |
| Target Patches | Critical/Important security patches | Prioritize high-severity |

### Patch Application Flow

```text
1. Every Sunday 12:00 JST
   ↓
2. Maintenance window starts
   ↓
3. Apply patches to NAT Instance #1
   ↓ (Reboot if needed)
   ↓
4. Apply patches to NAT Instance #2
   ↓ (Reboot if needed)
   ↓
5. Apply patches to NAT Instance #3
   ↓ (Reboot if needed)
   ↓
6. Completion notification (via SNS)
```

💡 For development environments: With single NAT Instance configuration, internet connection is temporarily lost during patch application (especially during reboot). Recommend setting maintenance window outside business hours.

## Best Practices

### 1. Security

```typescript
// ✅ Disable source/destination check for NAT Instance
// (Automatically set by NatProvider.instanceV2())

// ✅ Restrict traffic with security groups
(natProvider as ec2.NatInstanceProviderV2).connections.allowFrom(
  ec2.Peer.ipv4(vpc.vpcCidrBlock),
  ec2.Port.allTraffic(),
  'Allow all traffic from VPC',
);

// ✅ Access via Systems Manager Session Manager
// (Disable public SSH access)
```

### 2. Monitoring and Alerts

```typescript
// CloudWatch alarm configuration example
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';

const cpuAlarm = new cloudwatch.Alarm(this, 'NatInstanceCpuAlarm', {
  metric: new cloudwatch.Metric({
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensionsMap: {
      InstanceId: natInstanceId,
    },
    statistic: 'Average',
    period: cdk.Duration.minutes(5),
  }),
  threshold: 80,
  evaluationPeriods: 2,
  alarmDescription: 'NAT Instance CPU utilization is too high',
});

cpuAlarm.addAlarmAction(new actions.SnsAction(snsTopic));

// Patch compliance alarm
const complianceAlarm = new cloudwatch.Alarm(this, 'PatchComplianceAlarm', {
  metric: complianceMetric,
  threshold: 0,
  evaluationPeriods: 2,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
  alarmDescription: 'NAT Instance has missing security patches',
});

complianceAlarm.addAlarmAction(new actions.SnsAction(patchNotificationTopic));
```

### 3. Optimal Availability for Development Environments

In this architecture, we configured 3 NAT instances as a high-availability example, but for development environments, a single NAT instance is often sufficient. In that case, adjust the `natGateways` count.

```typescript
// Deploy NAT Instance to multiple AZs
const vpc = new ec2.Vpc(this, 'VpcNatInstanceV2', {
  natGateways: 1,  // Only 1 instance
  natGatewayProvider: natProvider,
});
```

Cost becomes:

- 3 instances: $9.30/month
- 1 instance: $3.10/month

## Troubleshooting

### Common Issues and Solutions

#### 1. Cannot Access Internet from Private Subnet After NAT Instance Stops

**Cause**: Stopped by schedule or manually stopped

**Solution**:

```bash
# Manually start NAT Instance
aws ec2 start-instances --instance-ids i-xxxxx

# Or temporarily disable schedule
aws events disable-rule --name YourProject-dev-NATStopRule-i-xxxxx
```

#### 2. Instance Not Showing in Systems Manager

**Cause**: IAM role missing `AmazonSSMManagedInstanceCore` policy

**Solution**:

```bash
# Check in Fleet Manager
aws ssm describe-instance-information \
  --query 'InstanceInformationList[].[InstanceId,PingStatus,PlatformName]' \
  --output table

# If instance not shown, check IAM role
aws iam list-attached-role-policies --role-name <NAT-Instance-Role-Name>
```

💡 NAT Instance IAM role requires the following policies:

- `AmazonSSMManagedInstanceCore` (For Systems Manager management)

#### 3. Patch Application Fails

**Cause**: Maintenance window IAM role missing `iam:PassRole` permission

**Solution**:

Check error in CloudTrail logs.

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=SendCommand \
  --max-results 5
```

If error is `InvalidDocument: document hash and hash type must both be present or none`, remove `documentHashType` parameter (not needed for AWS managed documents).

#### 4. Poor Performance

**Cause**: Instance type is too small

**Solution**: Change to larger instance type

```typescript
instanceType: ec2.InstanceType.of(
  ec2.InstanceClass.T4G,
  ec2.InstanceSize.MICRO,  // nano → micro
),
```

#### 5. Unexpected Shutdown

**Cause**: Need to check CloudWatch Logs

**Solution**:

```bash
# Check logs in Systems Manager
aws logs filter-log-events \
  --log-group-name /aws/ssm/automation \
  --filter-pattern "i-xxxxx"

# Check EC2 instance status history
aws ec2 describe-instance-status \
  --instance-ids i-xxxxx \
  --include-all-instances
```

### Troubleshooting Tips

- Utilize CloudTrail: Analyze API call failure reasons in detail
- Validate IAM permissions: Correctly configure conditional policies for `iam:PassRole`
- Systems Manager logs: Check detailed execution logs for patch application
- EventBridge metrics: Monitor schedule rule execution status

## Deployment and Cleanup

### Deployment

```bash
# Install dependencies
cd infrastructure/cdk-workspaces/workspaces/vpc-natinstance-v2
npm install

# Bootstrap CDK (first time only)
cdk bootstrap

# Deploy
cdk deploy "**" --project=YourProject --env=dev
```

### Cleanup

```bash
# Delete stack
cdk destroy "**" --project=YourProject --env=dev

# Skip confirmation prompt
cdk destroy "**" --project=YourProject --env=dev --force
```

⚠️ Notes:

- Elastic IPs are automatically released
- Flow logs in S3 bucket are auto-deleted due to `autoDeleteObjects: true`
- For production environments, use `removalPolicy: cdk.RemovalPolicy.RETAIN`

## Summary

NAT Instance is an excellent alternative to NAT Gateway. Especially for development environments, it offers the following benefits:

Benefits:

- Significant cost savings: Save over $400 annually
- Schedule management: Auto-stop outside business hours
- Flexible control: Security groups and Network ACLs
- Monitoring and alerts: CloudWatch and EventBridge integration

Drawbacks (Considerations):

- Single point of failure (for single instance)
- Performance limitations (depends on instance type)
- Operational management required (patching, monitoring)
- Additional cost for high availability configuration

### Recommendations

1. Development/Test environments: Use NAT Instance for cost optimization
2. Production environments: Use NAT Gateway for availability
3. Hybrid configuration: Choose optimal configuration per environment

## Reference Links

- [Previous article: VPC Basics](https://dev.to/aws-builders/aws-cdk-100-drill-exercises-003-vpc-basics-from-network-configuration-to-security-4a43)
- [AWS CDK VPC Construct](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.Vpc.html)
- [NAT Instance v2](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.NatInstanceProviderV2.html)
- [EventBridge Schedule Expressions](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-rule-schedule.html)
- [EC2 Instance Types](https://aws.amazon.com/ec2/instance-types/)
- [AWS Pricing Calculator](https://calculator.aws/)