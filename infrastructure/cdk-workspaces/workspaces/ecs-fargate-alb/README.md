# ECS-Fargate-ALB — Building Scalable Container Applications with Load Balancing

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

## Introduction

This project is a reference implementation that uses AWS CDK to build a production-ready container application platform combining ECS Fargate and Application Load Balancer (ALB).

This architecture demonstrates the following implementations:

- Multi-AZ VPC with cost-optimized NAT Instance
- ECR with Bootstrap deployment mode
- ECS Fargate with Fargate/Fargate Spot capacity providers
- Application Load Balancer with HTTPS support
- Auto-scaling based on CPU/memory utilization
- Cost-saving scheduler (start/stop tasks on schedule)
- OpenTelemetry/X-Ray integration for observability
- Security group design for ALB-to-ECS communication

### Why ECS-Fargate-ALB?

| Feature | Benefit |
| ------ | --------- |
| Serverless Containers | No EC2 instance management required |
| Auto-Scaling | Automatically scale based on demand |
| High Availability | Multi-AZ deployment with health checks |
| Cost Optimization | Fargate Spot + scheduled start/stop + NAT Instance |
| HTTPS Ready | Integrated ACM certificate support |
| Observability | Built-in OpenTelemetry/X-Ray support |

## Architecture Overview

![Architecture Overview](overview.drawio.svg)

---

## Prerequisites

- AWS CLI v2 installed and configured
- Docker installed and running
- Node.js 20+
- AWS CDK CLI (`npm install -g aws-cdk`)
- Basic TypeScript knowledge
- AWS account with appropriate permissions
- AWS CLI profile configuration

## Project Directory Structure

```text
ecs-fargate-alb/
├── bin/
│   └── ecs-fargate-alb.ts                  # Application entry point
├── lib/
│   ├── stacks/
│   │   ├── base-stack.ts                   # VPC and Security Groups
│   │   ├── ecr-stack.ts                    # ECR repositories
│   │   └── ecs-fargate-alb-stack.ts        # ECS Fargate and ALB
│   └── stages/
│       └── ecs-fargate-alb-stage.ts        # Deployment orchestration
├── parameters/
│   ├── environments.ts                     # Environment type definitions
│   └── dev-params.ts                       # Development environment parameters
├── src/
│   └── (Sample application code in backend/example-nodejs-api)
└── test/
    ├── snapshot/
    │   └── snapshot.test.ts                # Snapshot test
    └── unit/
        └── ecs-fargate-alb.test.ts         # Unit tests
```

---

### Data Flow

```text
Internet
    ↓
Application Load Balancer (HTTPS/HTTP)
    ↓
Target Group (Health Check)
    ↓
ECS Fargate Service (Multi-AZ)
    ├─ Container: Node.js API
    └─ Sidecar: OpenTelemetry Collector
    ↓
Observability (X-Ray, CloudWatch)
```

### Key Components and Design Points

| Component | Design Points |
| ------------- | ------------ |
| VPC | Multi-AZ (2 AZs), NAT Instance with auto-recovery, Scheduled start/stop |
| ECR | Bootstrap mode (CDK builds and pushes initial image), Lifecycle policies |
| ALB | HTTPS with ACM certificate (optional), Security group with IP restriction |
| ECS Fargate | Fargate Spot capacity provider, Auto-scaling, Scheduled start/stop |
| Container | Sample Node.js API (Express), Health check endpoint, Structured logging |
| Sidecar | OpenTelemetry or X-Ray daemon for distributed tracing |
| Security Groups | ALB → ECS inbound rules, Least privilege principle |

---

## Implementation Highlights

### 1. Multi-Stack Architecture

The architecture is organized into three separate stacks for better modularity and deployment flexibility:

```typescript
// Base Stack - VPC and Security Groups
const baseStack = new BaseStack(this, 'Base', {
  vpcConfig,
  allowedIpsforAlb: ['YOUR_IP/32'], // Restrict ALB access
  ports: [8080], // Container ports
});

// ECR Stack - Container image repositories
const ecrStack = new EcrStack(this, 'Ecr', {
  config: params,
  isBootstrapMode: process.env.CDK_ECR_BOOTSTRAP === 'true',
  commitHash: process.env.COMMIT_HASH || 'latest',
});

// ECS Fargate + ALB Stack
const ecsFargateStack = new EcsFargateAlbStack(this, 'EcsFargateAlb', {
  vpc: baseStack.vpc.vpc,
  ecsSecurityGroups: [baseStack.ecsSecurityGroup],
  albSecurityGroup: baseStack.albSecurityGroup,
  repositories: ecrStack.repositories,
});
```

### 2. ECR Bootstrap Mode

Two deployment modes are supported:

**Bootstrap Mode** (Initial deployment from CDK):
```bash
CDK_ECR_BOOTSTRAP=true npm run deploy:all -- --project=your-project --env=dev
```

The CDK builds Docker images from source code and pushes them to ECR during deployment.

**CI/CD Mode** (After initial deployment):
```bash
npm run deploy:all -- --project=your-project --env=dev
```

Expects images to already exist in ECR (pushed by CI/CD pipeline).

<details>
<summary>📝 ECR Configuration</summary>

```typescript
ecrConfig: {
  "backend": {
    createConfig: {
      repositoryNameSuffix: 'nodejs-backend-repo',
      imageSourcePath: '../../../../backend/example-nodejs-api',
      dockerfilePath: 'Dockerfile',
      buildArgs: {
        NODE_ENV: 'production'
      }
    }
  }
}
```

</details>

### 3. ECS Fargate with Fargate Spot

Cost-optimized capacity provider strategy using Fargate Spot:

```typescript
ecsFargateConfig: {
  createConfig: {
    capacityProviderStrategies: {
      fargateSpotWeight: 1,  // Use Fargate Spot for cost savings
      // fargateWeight: 1,    // Uncomment for standard Fargate
    },
    desiredCount: 1,
    taskDefinition: [
      {
        cpu: 512,
        memoryLimitMiB: 1024,
        containerDefinitions: {
          "backend": {
            cpu: 256,
            memoryLimitMiB: 512,
            port: 8080,
            enabledOtelSidecar: true,  // OpenTelemetry sidecar
            environment: {
              LOG_LEVEL: 'INFO',
              NODE_ENV: 'production'
            },
            healthCheck: {
              path: '/health',
              interval: cdk.Duration.seconds(30),
              timeout: cdk.Duration.seconds(5),
              healthyThresholdCount: 2,
              unhealthyThresholdCount: 5,
            }
          }
        }
      }
    ]
  }
}
```

> **Fargate Spot Savings**: Up to 70% cost reduction compared to standard Fargate. Best for fault-tolerant workloads.

### 4. Auto-Scaling Configuration

Automatic scaling based on CPU and memory utilization:

```typescript
autoScalingConfig: {
  minCapacity: 1,
  maxCapacity: 10,
  cpuUtilizationTargetPercent: 70,
  memoryUtilizationTargetPercent: 80,
  requestCountPerTarget: 1000  // ALB-based scaling
}
```

### 5. Cost-Saving Scheduler

Automatically start and stop ECS tasks on a schedule:

```typescript
startstopSchedulerConfig: {
  startCronSchedule: 'cron(5 18 ? * MON-FRI *)',  // Start at 18:05 JST Mon-Fri
  stopCronSchedule: 'cron(55 20 ? * MON-FRI *)',   // Stop at 20:55 JST Mon-Fri
  timeZone: cdk.TimeZone.ASIA_TOKYO,
}
```

**Monthly Savings Example (Development Environment)**:
- Without scheduler: 730 hours/month
- With scheduler (3h × 5 days × 4 weeks): 60 hours/month
- **Savings: ~92%** for development environment

### 6. Application Load Balancer with HTTPS

Optional HTTPS support with automatic certificate management:

```typescript
// With HTTPS (requires hostedZoneId)
hostedZoneId: 'Z0123456789ABCDEFGHIJ'  // Route53 Hosted Zone ID

// HTTP only (for testing)
// hostedZoneId: undefined
```

When `hostedZoneId` is provided:
- ACM certificate is automatically created
- HTTP (port 80) redirects to HTTPS (port 443)
- Recommended SSL policy applied

<details>
<summary>📝 ALB Security Group Configuration</summary>

```typescript
// Restrict access by IP address
allowedIpsforAlb: [
  '203.0.113.0/32',  // Office IP
  '198.51.100.0/24'  // VPN range
]

// Or allow public access (not recommended for production)
allowedIpsforAlb: []  // Allows 0.0.0.0/0
```

</details>

### 7. OpenTelemetry Integration

Built-in distributed tracing with OpenTelemetry or X-Ray:

```typescript
containerDefinitions: {
  "backend": {
    enabledOtelSidecar: true,   // OpenTelemetry (recommended)
    // enabledXraySidecar: true,  // Or X-Ray daemon
  }
}
```

**OpenTelemetry Benefits**:
- Vendor-neutral observability
- Future-proof (AWS is migrating from X-Ray daemon)
- Support for metrics, traces, and logs
- Compatible with AWS X-Ray service

### 8. NAT Instance with Auto-Recovery

Cost-optimized alternative to NAT Gateway:

```typescript
vpcConfig: {
  createConfig: {
    natCount: 1,
    natType: NatType.INSTANCE,  // Instead of NAT Gateway
    natSchedule: {
      startCronSchedule: 'cron(0 18 * * ? *)',  // 18:00 JST
      stopCronSchedule: 'cron(0 21 * * ? *)',   // 21:00 JST
      timeZone: cdk.TimeZone.ASIA_TOKYO,
    }
  }
}
```

**Cost Comparison (ap-northeast-1)**:

| Solution | Instance Type | Monthly Cost |
| -------- | ------------- | ------------ |
| NAT Gateway | - | ~$32 (24/7) |
| NAT Instance (t3.nano) | Always on | ~$10 |
| NAT Instance (scheduled 3h/day) | With schedule | ~$1.2 |

---

## Deployment Guide

### Step 1: Configure Environment Parameters

Edit `parameters/dev-params.ts`:

```typescript
const devParams: EnvParams = {
  region: 'ap-northeast-1',
  vpcConfig: { /* VPC settings */ },
  ecsFargateConfig: { /* ECS settings */ },
  ecrConfig: { /* ECR settings */ },
  hostedZoneId: 'Z0123...',  // Optional: for HTTPS
};
```

### Step 2: Bootstrap CDK (First time only)

```bash
npm run bootstrap -- --project=your-project --env=dev
```

### Step 3: Initial Deployment (Bootstrap Mode)

Build and push Docker images during CDK deployment:

```bash
CDK_ECR_BOOTSTRAP=true npm run deploy:all -- --project=your-project --env=dev
```

This will:
1. Create VPC and security groups
2. Create ECR repositories
3. **Build Docker images from source**
4. **Push images to ECR**
5. Deploy ECS Fargate and ALB

### Step 4: Access Your Application

After deployment, find the ALB DNS name in the CloudFormation outputs:

```bash
# Get ALB DNS name
aws cloudformation describe-stacks \
  --stack-name YourProject-Dev-EcsFargateAlb \
  --query 'Stacks[0].Outputs[?OutputKey==`AlbDnsName`].OutputValue' \
  --output text
```

Access your application:
```bash
# HTTP (no certificate)
curl http://<ALB-DNS-NAME>/health

# HTTPS (with certificate)
curl https://your-project.dev.example.com/health
```

### Step 5: Subsequent Deployments (CI/CD Mode)

After initial deployment, use CI/CD to build and push images:

```bash
# CI/CD pipeline pushes new image to ECR
docker buildx build --platform linux/amd64 -t <ECR-URL>:<COMMIT-HASH> .
docker push <ECR-URL>:<COMMIT-HASH>

# CDK deployment uses existing image
COMMIT_HASH=<COMMIT-HASH> npm run deploy:all -- --project=your-project --env=dev
```

---

## Testing

### Run All Tests

```bash
npm test -w workspaces/ecs-fargate-alb
```

### Run Snapshot Tests

```bash
npm run test:snapshot -w workspaces/ecs-fargate-alb
```

### Run Unit Tests

```bash
npm test -w workspaces/ecs-fargate-alb -- test/unit
```

---

## Customization

### Adding New Containers

Add a new container definition:

```typescript
containerDefinitions: {
  "backend": { /* existing */ },
  "frontend": {
    cpu: 256,
    memoryLimitMiB: 512,
    port: 3000,
    enabledOtelSidecar: true,
    healthCheck: {
      path: '/',
      interval: cdk.Duration.seconds(30),
    }
  }
}
```

And add corresponding ECR configuration:

```typescript
ecrConfig: {
  "backend": { /* existing */ },
  "frontend": {
    createConfig: {
      repositoryNameSuffix: 'react-frontend-repo',
      imageSourcePath: '../../../../frontend/example-react-app',
    }
  }
}
```

### Enabling Auto-Scaling

Add auto-scaling configuration:

```typescript
autoScalingConfig: {
  minCapacity: 2,
  maxCapacity: 20,
  cpuUtilizationTargetPercent: 70,
  memoryUtilizationTargetPercent: 80,
}
```

### Path-Based Routing

Configure ALB listener rules for different paths:

```typescript
albConditions: {
  pathPatterns: ['/api/*', '/v1/*'],
  hostHeaders: ['api.example.com']
}
```

---

## Cost Estimation

<details>
<summary>💰 Monthly Estimate (Tokyo Region)</summary>

### Development Environment (with schedulers)

| Service | Usage | Monthly Cost |
| -------- | ------ | -------- |
| ECS Fargate (Spot) | 0.25 vCPU, 0.5GB, 60h/month | ~$0.90 |
| NAT Instance (t3.nano) | 60h/month | ~$1.20 |
| ALB | Basic usage | ~$16.00 |
| ECR | 5GB storage | ~$0.50 |
| CloudWatch Logs | 5GB | ~$0.27 |

**Development Total: ~$19/month**

### Production Environment (24/7)

| Service | Usage | Monthly Cost |
| -------- | ------ | -------- |
| ECS Fargate (Standard) | 0.25 vCPU, 0.5GB, 2 tasks | ~$26.40 |
| NAT Gateway (x2 AZs) | 10GB transfer | ~$65.00 |
| ALB | 100GB processed | ~$23.00 |
| ECR | 10GB storage | ~$1.00 |
| CloudWatch Logs | 20GB | ~$1.08 |

**Production Total: ~$116/month**

</details>

<details>
<summary>💡 Cost Optimization Tips</summary>

1. **Fargate Spot**: Use for non-critical workloads (up to 70% savings)
2. **Scheduler**: Stop dev/test environments when not in use
3. **NAT Instance**: Use instead of NAT Gateway for low-traffic environments
4. **Auto-Scaling**: Set appropriate min/max to avoid over-provisioning
5. **Log Retention**: Set shorter retention periods for CloudWatch Logs
6. **Reserved Capacity**: Consider Savings Plans for production workloads

</details>

---

## Security Considerations

### Network Security

- ✅ VPC with public and private subnets
- ✅ ALB in public subnet, ECS tasks in private subnet
- ✅ Security groups with least privilege
- ✅ IP-based access restriction for ALB
- ✅ HTTPS with ACM certificates

### Container Security

- ✅ Non-root user in containers
- ✅ Read-only root filesystem (recommended)
- ✅ Secrets from AWS Secrets Manager
- ✅ Regular image scanning (ECR)
- ✅ Minimal base images

### IAM Security

- ✅ Task execution role (for pulling images)
- ✅ Task role (for application permissions)
- ✅ Separate roles for each task definition
- ✅ Least privilege principle

---

## Troubleshooting

### Container Not Starting

**Symptom**: ECS tasks fail to start or immediately stop

**Possible Causes**:
1. Invalid container image
2. Insufficient memory/CPU
3. Health check failures
4. Missing environment variables

**Solution**:
```bash
# Check ECS task stopped reason
aws ecs describe-tasks \
  --cluster <CLUSTER-NAME> \
  --tasks <TASK-ARN> \
  --query 'tasks[0].stoppedReason'

# Check CloudWatch Logs
aws logs tail /aws/ecs/<PROJECT>-<ENV>-ecs-fargate --follow
```

### ALB Showing 503 Errors

**Symptom**: ALB returns 503 Service Unavailable

**Possible Causes**:
1. No healthy targets
2. Security group blocking traffic
3. Health check path incorrect

**Solution**:
```bash
# Check target health
aws elbv2 describe-target-health \
  --target-group-arn <TG-ARN>

# Verify security group allows ALB → ECS traffic
# Check health check configuration
```

### Bootstrap Mode Failing

**Symptom**: Docker build fails during CDK deployment

**Possible Causes**:
1. Docker daemon not running
2. Insufficient disk space
3. Build timeout (default 10 min)
4. Build context too large

**Solution**:
```bash
# Verify Docker is running
docker info

# Build image manually to debug
cd backend/example-nodejs-api
docker build -t test .

# Increase build timeout
cdk deploy --toolkit-stack-name CDKToolkit --context ecrAssetTimeout=1800
```

### Scheduled Start/Stop Not Working

**Symptom**: ECS tasks don't start/stop on schedule

**Possible Causes**:
1. EventBridge Scheduler rule disabled
2. IAM permissions missing
3. Incorrect timezone

**Solution**:
```bash
# Check scheduler rules
aws scheduler list-schedules

# Check rule state
aws scheduler get-schedule --name <SCHEDULE-NAME>

# Verify timezone and cron expression
```

---

## Clean-up

To delete all resources:

```bash
npm run destroy:all -- --project=your-project --env=dev
```

**Note**: If termination protection is enabled, disable it first in the AWS Console.

Manual cleanup may be required for:
- ECR images (if retention policy not set)
- CloudWatch Log groups
- Route53 records

---

## Summary

Key learnings from this pattern:

1. **Multi-Stack Architecture**: Separation of VPC, ECR, and ECS for modularity
2. **Bootstrap vs CI/CD Mode**: Flexibility in deployment approach
3. **Cost Optimization**: Fargate Spot + NAT Instance + Schedulers
4. **Security-First**: Network isolation, security groups, HTTPS
5. **Observability**: OpenTelemetry integration for distributed tracing
6. **Production-Ready**: Auto-scaling, health checks, multi-AZ

---

## References

- [AWS ECS Best Practices](https://docs.aws.amazon.com/AmazonECS/latest/bestpracticesguide/intro.html)
- [Amazon ECS on AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- [Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html)
- [AWS CDK ECS Patterns](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs_patterns-readme.html)
- [Fargate Spot](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-capacity-providers.html)
- [OpenTelemetry on AWS](https://aws-otel.github.io/)
