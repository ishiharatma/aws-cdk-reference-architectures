# VPC-BASICS

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-200-green?style=flat-square)
![Services](https://img.shields.io/badge/Services-VPC-purple?style=flat-square)

## Introduction

This architecture demonstrates:

- Two approaches to creating VPCs with CDK (default and custom)
- Subnet design and CIDR block calculations
- Differences between public/private subnets
- Roles of NAT Gateway and Internet Gateway
- Network traffic monitoring with VPC Flow Logs
- Implementation of VPC Endpoints (Gateway/Interface)
- Secure SSH access via EC2 Instance Connect Endpoint
- Mutual security group references and avoiding circular dependencies

## Architecture Overview

This is what we'll build:

![Architecture Overview](overview.png)

We'll implement two patterns:

- Default VPC: Created with CDK default settings
- Custom VPC: Created with custom configuration

### 1. Default VPC (CDKDefault)

- VPC created with CDK default settings
- Fully functional VPC with minimal code

### 2. Custom VPC (CustomVPC)

- Custom VPC creation with:
  - Up to 3 Availability Zones (varies by region)
  - 6 types of subnets (External, Management, Internal, Application, Isolated, TransitGateway)
  - Custom CIDR blocks
  - Single NAT Gateway (cost optimization)
- VPC Flow Logs implementation
  - All traffic logged to S3
  - Rejected traffic logged to CloudWatch Logs
- VPC Endpoints
  - Gateway Endpoints (S3, DynamoDB)
  - Interface Endpoints (Systems Manager)
- EC2 Instance Connect Endpoint
  - Secure SSH access without internet exposure
  - Mutual security group references

## Prerequisites

- AWS CLI v2 installed and configured
- Node.js 20+
- AWS CDK CLI (`npm install -g aws-cdk`)
- TypeScript basics
- AWS account (Free Tier eligible)
- Understanding of VPC basics (CIDR, subnets, routing)

## Project Structure

```text
vpc-basics/
├── bin/
│   └── vpc-basics.ts                    # Application entry point
├── lib/
│   └── stacks/
│       ├── vpc-cdkdefault-stack.ts      # CDK Default VPC Creation Stack
│       └── vpc-basics-stack.ts          # Custom VPC stack definition
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts              # CDK Nag compliance tests
│   ├── snapshot/
│   │   └── snapshot.test.ts             # Snapshot tests
│   └── unit/
│       ├── vpc-cdkdefault-stack.ts      # Main stack definition
│       └── vpc-basics.test.ts           # Unit tests
├── cdk.json
├── package.json
└── tsconfig.json
```

## Pattern 1: Understanding CDK Default VPC

The simplest VPC creation. CDK automatically configures everything.

```typescript
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export class VpcCDKDefaultStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create VPC with CDK defaults
    new ec2.Vpc(this, 'CDKDefault', {});
  }
}
```

### Default Configuration Details

CDK automatically configures:

- CIDR Block: `10.0.0.0/16` (65,536 IP addresses)
- Availability Zones: Available AZs in the region (up to 3)
- Subnet configuration:
  - Public subnet: One per AZ
  - Private subnet: One per AZ
- NAT Gateway: One per AZ (high availability)
- Internet Gateway: 1
- Route tables: Automatically configured

Generated resources:

```text
CDKDefault VPC (10.0.0.0/16)
├── AZ-1
│   ├── Public Subnet (10.0.0.0/19)    - 8,192 IPs
│   ├── Private Subnet (10.0.96.0/19)  - 8,192 IPs
│   └── NAT Gateway
├── AZ-2
│   ├── Public Subnet (10.0.32.0/19)   - 8,192 IPs
│   ├── Private Subnet (10.0.128.0/19) - 8,192 IPs
│   └── NAT Gateway
├── AZ-3
│   ├── Public Subnet (10.0.64.0/19)   - 8,192 IPs
│   ├── Private Subnet (10.0.160.0/19) - 8,192 IPs
│   └── NAT Gateway
└── Internet Gateway
```

### Pros and Cons of Default VPC

Pros:

- Minimal code
- Production-ready configuration
- High availability (multiple AZs, multiple NAT Gateways)
- Follows best practices

Cons:

- Higher cost (multiple NAT Gateways)
- Cannot customize CIDR range
- Cannot adjust subnet count

💡 For development environments, we recommend using custom VPCs for cost savings.

## Pattern 2: Custom VPC Creation

For real projects, create VPCs tailored to your requirements.

```typescript
import { pascalCase } from "change-case-commonjs";

const vpcName = [
  pascalCase(props.project),         // Project name
  pascalCase(props.environment),     // Environment identifier (dev/test/prod)
  'CustomVPC',                       // Purpose
]
  .join('/');

const customVpc = new ec2.Vpc(this, 'CustomVPC', {
  vpcName,
  ipAddresses: ec2.IpAddresses.cidr('10.1.0.0/16'),
  maxAzs: 3,              // Use up to 3 AZs
  natGateways: 1,         // Single NAT Gateway (cost optimization)
  subnetConfiguration: [
    {
      cidrMask: 26,       // 64 IPs per AZ (/26 = 2^(32-26) = 64)
      name: 'External',
      subnetType: ec2.SubnetType.PUBLIC,
    },
    {
      cidrMask: 27,       // 32 IPs per AZ (/27 = 2^(32-27) = 32)
      name: 'Management',
      subnetType: ec2.SubnetType.PUBLIC,
    },
    {
      cidrMask: 22,       // 1024 IPs per AZ (/22 = 2^(32-22) = 1024)
      name: 'Internal',
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    },
    {
      cidrMask: 22,       // 1024 IPs per AZ
      name: 'Application',
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    },
    {
      cidrMask: 24,       // 256 IPs per AZ (/24 = 2^(32-24) = 256)
      name: 'Isolated',
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    },
    {
      cidrMask: 28,       // 16 IPs per AZ (/28 = 2^(32-28) = 16)
      name: 'TransitGateway',
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    }
  ],
});
```

### Understanding CIDR Calculation

CIDR (Classless Inter-Domain Routing) defines IP address ranges.

Basic calculation formula:

```text
Available IP addresses = 2^(32 - CIDR mask)

/16 = 2^(32-16) = 2^16 = 65,536 IPs
/22 = 2^(32-22) = 2^10 = 1,024 IPs
/24 = 2^(32-24) = 2^8  = 256 IPs
/26 = 2^(32-26) = 2^6  = 64 IPs
/27 = 2^(32-27) = 2^5  = 32 IPs
/28 = 2^(32-28) = 2^4  = 16 IPs
```

AWS reserves 5 IPv4 addresses in each subnet ([documentation](https://docs.aws.amazon.com/vpc/latest/userguide/subnet-sizing.html)):

- `.0`: Network address
- `.1`: VPC router
- `.2`: DNS
- `.3`: Reserved for future use
- `.255`: Broadcast (not usable in VPC but reserved)

Actual available IPs = `calculated value - 5`

### Subnet Type Differences

| Type | Description | Routing | Use Cases |
|------|-------------|---------|-----------|
| `PUBLIC` | Route to Internet Gateway | Internet via IGW | Load balancers, NAT Gateway, Bastion |
| `PRIVATE_WITH_EGRESS` | Route to NAT Gateway | Outbound only via NAT | Application servers, VPC endpoints |
| `PRIVATE_ISOLATED` | No internet route | VPC only | Databases, Transit Gateway attachments |

### Subnet Configuration Design

```text
CustomVPC (10.1.0.0/16) - 65,536 IPs
├── AZ-1 (ap-northeast-1a)
│   ├── ExternalSubnet-1 (10.1.0.0/26)           - 64 IPs (59 available)
│   ├── ManagementSubnet-1 (10.1.0.64/27)        - 32 IPs (27 available)
│   ├── InternalSubnet-1 (10.1.0.128/22)         - 1,024 IPs (1,019 available)
│   ├── ApplicationSubnet-1 (10.1.4.128/22)      - 1,024 IPs (1,019 available)
│   ├── IsolatedSubnet-1 (10.1.8.128/24)         - 256 IPs (251 available)
│   └── TransitGatewaySubnet-1 (10.1.9.0/28)     - 16 IPs (11 available)
├── AZ-2 (ap-northeast-1c)
│   ├── ExternalSubnet-2 (10.1.0.96/26)          - 64 IPs (59 available)
│   ├── ManagementSubnet-2 (10.1.0.160/27)       - 32 IPs (27 available)
│   ├── InternalSubnet-2 (10.1.9.16/22)          - 1,024 IPs (1,019 available)
│   ├── ApplicationSubnet-2 (10.1.13.16/22)      - 1,024 IPs (1,019 available)
│   ├── IsolatedSubnet-2 (10.1.17.16/24)         - 256 IPs (251 available)
│   └── TransitGatewaySubnet-2 (10.1.18.0/28)    - 16 IPs (11 available)
├── AZ-3 (ap-northeast-1d)
│   ├── ExternalSubnet-3 (10.1.0.192/26)         - 64 IPs (59 available)
│   ├── ManagementSubnet-3 (10.1.0.224/27)       - 32 IPs (27 available)
│   ├── InternalSubnet-3 (10.1.17.32/22)         - 1,024 IPs (1,019 available)
│   ├── ApplicationSubnet-3 (10.1.21.32/22)      - 1,024 IPs (1,019 available)
│   ├── IsolatedSubnet-3 (10.1.25.32/24)         - 256 IPs (251 available)
│   └── TransitGatewaySubnet-3 (10.1.26.32/28)   - 16 IPs (11 available)
├── NAT Gateway (AZ-1 only)
└── Internet Gateway
```

### Why 6 Types of Subnets?

More subnets isn't always better, but we created 6 as an example of subnet segregation.
Dividing subnets too finely wastes reserved IPs per subnet, so adjust your configuration based on actual project requirements.
For basic projects, 2 types (Public and Private) are often sufficient.

1. ExternalSubnet (Public): For internet-facing load balancers, NAT Gateway
2. ManagementSubnet (Public): For Bastion hosts and operational management
3. InternalSubnet (Private with Egress): For VPC endpoints, internal load balancers
4. ApplicationSubnet (Private with Egress): For application servers, ECS tasks, Lambda functions
5. IsolatedSubnet (Private Isolated): For databases like RDS, ElastiCache
6. TransitGatewaySubnet (Private Isolated): Dedicated for Transit Gateway attachments (on-premises connectivity)

## VPC Flow Logs Implementation

VPC Flow Logs record network traffic within your VPC.

### Flow Logs to S3

```typescript
import * as s3 from 'aws-cdk-lib/aws-s3';

// Create secure S3 bucket
const flowLogBucket = new s3.Bucket(this, 'FlowLogBucket', {
  encryption: s3.BucketEncryption.S3_MANAGED,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  enforceSSL: true,  // Require HTTPS
  removalPolicy: cdk.RemovalPolicy.DESTROY,  // ⚠️ For dev (use RETAIN for prod)
  autoDeleteObjects: true,  // ⚠️ For dev (use RETAIN removalPolicy for prod)
});

// Log all traffic to S3
customVpc.addFlowLog('FlowLogToS3', {
  destination: ec2.FlowLogDestination.toS3(
    flowLogBucket,
    'vpcFlowLog/',
    {
      fileFormat: ec2.FlowLogFileFormat.PLAIN_TEXT,
      hiveCompatiblePartitions: true,  // For Athena queries
      perHourPartition: true,
    }
  ),
  trafficType: ec2.FlowLogTrafficType.ALL,
});
```

Generated log file structure:

```text
s3://bucket-name/vpcFlowLog/
└── AWSLogs/
    └── aws-account-id=123456789012/
        └── aws-service=vpcflowlogs/
            └── aws-region=ap-northeast-1/
                └── year=2024/
                    └── month=12/
                        └── day=20/
                            └── hour=12/
                                └── <AWSAccountID>_vpcflowlogs_<region>_xxxxx.log.gz
```

### Flow Logs to CloudWatch Logs

```typescript
import * as logs from 'aws-cdk-lib/aws-logs';

// Log rejected traffic only to CloudWatch Logs
customVpc.addFlowLog('FlowLog', {
  destination: ec2.FlowLogDestination.toCloudWatchLogs(
    new logs.LogGroup(this, 'FlowLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })
  ),
  trafficType: ec2.FlowLogTrafficType.REJECT,  // Rejected only
});
```

### Flow Logs Comparison

| Destination | Pros | Cons | Use Cases |
|-------------|------|------|-----------|
| S3 | - Ideal for long-term storage<br>- Queryable with Athena<br>- Cost effective | - No real-time analysis | Auditing, compliance, long-term analysis |
| CloudWatch Logs | - Real-time monitoring<br>- Metric filters<br>- Alerting | - Higher storage costs | Security monitoring, immediate threat detection |

### Flow Log Format

```text
version account-id interface-id srcaddr dstaddr srcport dstport protocol packets bytes start end action log-status
2 123456789012 eni-1234abcd 10.0.1.5 203.0.113.5 49152 80 6 10 5000 1670000000 1670000060 ACCEPT OK
```

Key fields ([documentation](https://docs.aws.amazon.com/vpc/latest/userguide/flow-log-records.html#flow-logs-fields)):

- `srcaddr/dstaddr`: Source/destination IP addresses
- `srcport/dstport`: Source/destination ports
- `protocol`: IP protocol number (6=TCP, 17=UDP)
- `action`: ACCEPT or REJECT

## VPC Endpoints

VPC Endpoints allow access to AWS services without going through the internet.
Gateway endpoints are free and reduce NAT Gateway data transfer costs, so we recommend creating them when communicating with supported services.

### Gateway Endpoints (S3 and DynamoDB)

```typescript
const endpointSubnets = customVpc.selectSubnets({
    subnetGroupName: 'Internal',
});
// S3 Gateway Endpoint
customVpc.addGatewayEndpoint('S3Endpoint', {
  service: ec2.GatewayVpcEndpointAwsService.S3,
  subnets: [{ subnets: endpointSubnets.subnets }],
});

// DynamoDB Gateway Endpoint
customVpc.addGatewayEndpoint('DynamoDbEndpoint', {
  service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
  subnets: [{ subnets: endpointSubnets.subnets }],
});
```

### Interface Endpoints (Systems Manager)

```typescript
// SSM Interface Endpoint
customVpc.addInterfaceEndpoint('SSMEndpoint', {
  service: ec2.InterfaceVpcEndpointAwsService.SSM,
  subnets: {
    subnets: endpointSubnets.subnets,
  },
});

// SSM Messages Interface Endpoint
customVpc.addInterfaceEndpoint('SSMMessagesEndpoint', {
  service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
  subnets: {
    subnets: endpointSubnets.subnets,
  },
});
```

### Gateway vs Interface Endpoints

| Feature | Gateway Endpoint | Interface Endpoint |
|---------|------------------|---------------------|
| Services | S3, DynamoDB only | Most AWS services |
| Implementation | Route table entry | ENI (Elastic Network Interface) |
| Pricing | Free | Charged hourly + data transfer |
| DNS | Not required | Can use private DNS |
| Security Groups | Not supported | Supported |
| Availability | High (automatic) | Per ENI (per AZ) |

### Why Use VPC Endpoints?

1. Security: Traffic doesn't traverse the internet
2. Performance: Lower latency
3. Cost savings: Reduce NAT Gateway data transfer charges
4. Compliance: Keep data within AWS network

## EC2 Instance Connect Endpoint

[EC2 Instance Connect Endpoint](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-with-ec2-instance-connect-endpoint.html) allows SSH connections to EC2 instances in private subnets without public IPs or Bastion hosts.

```typescript
// Security group for Instance Connect
const ec2InstanceConnectsg = new ec2.SecurityGroup(this, 'EC2InstanceConnectSG', {
  vpc: customVpc,
  description: 'Security group for EC2 Instance Connect Endpoint',
  allowAllOutbound: false,  // Deny default outbound
});

// Select first subnet in InternalSubnet
const iceSubnet = endpointSubnets.subnets[0];

// Create Instance Connect Endpoint
new ec2.CfnInstanceConnectEndpoint(this, 'EC2InstanceConnectEndpoint', {
  subnetId: iceSubnet.subnetId,
  preserveClientIp: false,
  securityGroupIds: [ec2InstanceConnectsg.securityGroupId],
});

// Security group for EC2 instances
const ec2sg = new ec2.SecurityGroup(this, 'EC2SG', {
  vpc: customVpc,
  description: 'Security group for EC2 instances',
  allowAllOutbound: true,
});
```

### Mutual Security Group References and Avoiding Circular Dependencies

⚠️ Important: Using `addIngressRule` or `addEgressRule` creates circular dependencies between security groups.
While `cdk synth` succeeds, `cdk deploy` will fail.

Wrong way (creates circular dependency):

```typescript
// ❌ This will error
ec2sg.addIngressRule(
  ec2InstanceConnectsg,
  ec2.Port.tcp(22),
  'Allow SSH from Instance Connect'
);

ec2InstanceConnectsg.addEgressRule(
  ec2sg,
  ec2.Port.tcp(22),
  'Allow SSH to EC2 instances'
);
// ❌  Dev-DrillexercisesVpcBasics failed: ValidationError: Circular dependency between resources: [EC2InstanceConnectSG697BC6D2, EC2InstanceConnectEndpoint, EC2SG244E8056]
```

Correct way (using CloudFormation resources directly):

```typescript
// ✅ Use CfnSecurityGroupIngress/Egress
// Ingress: Instance Connect SG -> EC2 SG
new ec2.CfnSecurityGroupIngress(this, 'AllowSSHFromInstanceConnect', {
  ipProtocol: 'tcp',
  fromPort: 22,
  toPort: 22,
  groupId: ec2sg.securityGroupId,
  sourceSecurityGroupId: ec2InstanceConnectsg.securityGroupId,
  description: 'Allow SSH from Instance Connect SG',
});

// Egress: Instance Connect SG -> EC2 SG
new ec2.CfnSecurityGroupEgress(this, 'AllowSSHToEC2SG', {
  ipProtocol: 'tcp',
  fromPort: 22,
  toPort: 22,
  groupId: ec2InstanceConnectsg.securityGroupId,
  destinationSecurityGroupId: ec2sg.securityGroupId,
  description: 'Allow SSH to EC2 SG',
});
```

### Using Instance Connect Endpoint

Connect to EC2 instances via Instance Connect Endpoint using AWS CLI ([documentation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-connect-methods.html#connect-linux-inst-eic-cli-ssh)):

```bash
# SSH via Instance Connect Endpoint
aws ec2-instance-connect ssh \
  --instance-id i-1234567890abcdef0 \
  --connection-type eice
```

### Why Use Instance Connect Endpoint?

Comparison with traditional methods:

| Method | Public IP | Bastion Host | SSH Key Management | Additional Cost |
|--------|-----------|--------------|---------------------|-----------------|
| Public IP on EC2 | Required | ✅ Not needed | Required | ✅ None |
| Bastion Host | Bastion needs it | Required | Required | EC2 charges |
| Instance Connect Endpoint | ✅ Not needed | ✅ Not needed | ✅ Not needed | Yes |

Benefits:

- No internet exposure
- No SSH key management (IAM authentication)
- No Bastion host needed (cost savings)
- All connections logged in CloudTrail

## CloudFormation Output Example

Key parts of the generated CloudFormation template after deployment:

```json
{
  "Resources": {
    "CustomVPC616E3387": {
      "Type": "AWS::EC2::VPC",
      "Properties": {
        "CidrBlock": "10.1.0.0/16",
        "EnableDnsHostnames": true,
        "EnableDnsSupport": true,
        "Tags": [
          {
            "Key": "Name",
            "Value": "Myproject/Dev/CustomVPC"
          }
        ]
      }
    },
    "CustomVPCS3Endpoint": {
      "Type": "AWS::EC2::VPCEndpoint",
      "Properties": {
        "ServiceName": "com.amazonaws.ap-northeast-1.s3",
        "VpcEndpointType": "Gateway",
        "RouteTableIds": [...]
      }
    },
    "CustomVPCSSMEndpoint": {
      "Type": "AWS::EC2::VPCEndpoint",
      "Properties": {
        "ServiceName": "com.amazonaws.ap-northeast-1.ssm",
        "VpcEndpointType": "Interface",
        "PrivateDnsEnabled": true,
        "SecurityGroupIds": [...],
        "SubnetIds": [...]
      }
    }
  }
}
```

## Deploy and Validate

### Deploy

```bash
# Check diff
cdk diff --project=myproject --env=dev

# Deploy
cdk deploy "**" --project=myproject --env=dev
```

### Validate

1. Verify VPC

   ```bash
   # List VPCs
   aws ec2 describe-vpcs \
     --filters "Name=tag:Name,Values=*Myproject/Dev/CustomVPC*"
   
   # Verify subnets
   aws ec2 describe-subnets \
     --filters "Name=vpc-id,Values=<vpc-id>"
   ```

2. Verify VPC Endpoints

   ```bash
   # List VPC endpoints
   aws ec2 describe-vpc-endpoints \
     --filters "Name=vpc-id,Values=<vpc-id>"
   ```

3. Verify Flow Logs

   ```bash
   # Check logs in S3 bucket
   aws s3 ls s3://<bucket-name>/vpcFlowLog/ --recursive
   
   # Check CloudWatch Logs
   aws logs describe-log-streams \
     --log-group-name <log-group-name>
   ```

4. Verify Security Groups

   ```bash
   # List security groups
   aws ec2 describe-security-groups \
     --filters "Name=vpc-id,Values=<vpc-id>"
   ```

### Cleanup

```bash
# Delete stack
cdk destroy "**" --project=myproject --env=dev

# Force delete without confirmation
cdk destroy "**" --force --project=myproject --env=dev
```

💡 Note

- In this example, `autoDeleteObjects: true` is set for development, so the S3 bucket is automatically deleted when the stack is deleted
- For production, consider using `removalPolicy: cdk.RemovalPolicy.RETAIN` to protect data

## Best Practices

### Network Design

1. CIDR Planning: Design CIDR blocks considering future expansion
2. Multiple AZs: Use at least 2 AZs for high availability
   - `maxAzs` specifies maximum number, actual count depends on region
   - Tokyo region (ap-northeast-1) has up to 3 AZs available
3. Subnet Isolation: Use different subnets for different tiers (Web, App, DB)
4. Reserved IPs: Account for 5 IPs reserved by AWS per subnet

### Security

1. Least Privilege: Open only necessary ports in security groups
2. Flow Logs: Enable flow logs for all VPCs
3. VPC Endpoints: Use to avoid internet routing
4. Private Subnets: Place databases in completely isolated subnets
5. NACLs: Provide additional layers with Network ACLs as needed

### Cost Optimization

1. NAT Gateway Count: One NAT Gateway is sufficient for development
2. VPC Endpoints: Choose based on usage frequency
   - High frequency: Interface Endpoint (worth the hourly cost)
   - Low frequency: Via NAT Gateway (pay-as-you-go)
3. Flow Logs: Use S3 for cost-effective long-term storage
4. Resource Tags: Tag all resources for cost tracking

### Operations

1. Naming Convention: Use consistent naming pattern

   ```text
   Example: {project}-{environment}-{resource}-{account}-{region}
   ```

2. Tagging Strategy: Use Environment, Project, Owner, CostCenter tags
3. Monitoring: Monitor VPC metrics with CloudWatch
4. Documentation: Document network diagrams and CIDR allocations

### Testing

1. Snapshot Tests: Clarify change diffs
2. Unit Tests: Validate resource existence and configuration
3. Compliance Tests: Check security best practices with CDK Nag

## Cost Estimate

### Sample Pricing (Tokyo Region)

For CDK Default VPC:

| Resource | Quantity | Monthly Cost (Estimate) |
|----------|----------|-------------------------|
| VPC | 1 | $0 (Free) |
| NAT Gateway | 3 | $133.92 ($0.062/hour × 24 × 30 × 3) |
| NAT Gateway data processing | 100GB | $18.6 ($0.062/GB × 3) |
| VPC Gateway Endpoint | - | $0 |
| VPC Interface Endpoint | - | $0 |
| Endpoint data processing | - | $0 |
| Total | - | ~$152.52/month |

For Custom VPC:

| Resource | Quantity | Monthly Cost (Estimate) |
|----------|----------|-------------------------|
| VPC | 1 | $0 (Free) |
| NAT Gateway | 1 | $39.42 ($0.062/hour × 24 × 30) |
| NAT Gateway data processing | 100GB | $6.20 ($0.062/GB) |
| VPC Gateway Endpoint | 2 | $0 |
| VPC Interface Endpoint | 2 | $15.12 ($0.012/hour × 2 × 24 × 30) |
| Endpoint data processing | 10GB | $0.12 ($0.012/GB) |
| S3 storage (Flow Logs) | 50GB | $1.15 ($0.023/GB) |
| CloudWatch Logs (7-day retention) | 5GB | $0.35 ($0.033/GB) |
| Total | - | ~$62.36/month |

💡 Cost Savings Tips

- Development: 1 NAT Gateway is sufficient (multiple recommended for production) or use NAT instance with EC2
- Flow Logs: Can be temporarily disabled in development
- VPC Endpoints: Choose based on usage frequency

## Summary

In this exercise, we learned VPC fundamentals through AWS CDK.

### What We Learned

1. VPC Basics: Difference between CDK default and custom VPCs
2. Subnet Design: CIDR calculation and 6-tier subnet configuration
3. Traffic Management: NAT Gateway, Internet Gateway, routing
4. Visibility: Network monitoring with VPC Flow Logs
5. VPC Endpoints: When to use Gateway vs Interface Endpoints
6. Secure Access: Instance Connect Endpoint implementation
7. Security Groups: Mutual references and avoiding circular dependencies
8. Best Practices: Security, cost, and operational perspectives

### Key Takeaways

- Network Design: Proper CIDR planning is crucial for future expansion
- Security Layers: Network-level isolation and control
- Visibility: Flow log monitoring is essential
- Cost Optimization: Choice of NAT Gateway count and VPC endpoints
- High Availability: Multi-AZ and failover design

## References

- [Amazon VPC Official Documentation](https://docs.aws.amazon.com/vpc/)
- [VPC Best Practices](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-best-practices.html)
- [VPC Flow Logs](https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs.html)
- [VPC Endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints.html)
- [EC2 Instance Connect Endpoint](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-with-ec2-instance-connect-endpoint.html)