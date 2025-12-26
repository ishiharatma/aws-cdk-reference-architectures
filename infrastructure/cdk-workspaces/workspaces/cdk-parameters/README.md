# CDK-PARAMETERS — Managing Parameters with TypeScript vs cdk.json

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

## Introduction

In this architecture, you can explore the following implementations:

- How to define parameters in TypeScript files (type-safety focused)
- How to define parameters in cdk.json (flexibility focused)
- Environment-specific parameter management and best practices
- Parameter validation at deployment time
- Pros and cons of each approach
- When to use which approach in production

### Why is Parameter Management Important?

1. Environment Isolation: Use different configurations for development, staging, and production
2. Code Reusability: Reuse the same code with different configurations
3. Configuration Visibility: Make it clear what values are being used
4. Ease of Change: Change configurations without modifying code
5. Type Safety: Leverage TypeScript's type system for safe configuration management

## Architecture Overview

Here's what we'll build:

![Architecture Overview](overview.png)

We'll implement two parameter management approaches.

### 1. TypeScript Parameters (CdkTSParametersStack)

- Define parameters in TypeScript files
- Type safety and IDE support
- Separate parameter files for each environment
- Compile-time validation

### 2. cdk.json Parameters (CdkJsonParametersStack)

- Define parameters in the context section of cdk.json
- JSON-based flexible configuration
- Standard CDK approach
- Easy dynamic value retrieval

Both approaches create the same VPC resources, but differ in how parameters are defined and type safety is ensured.

## Prerequisites

To proceed with this exercise, you'll need:

- AWS CLI v2 installed and configured
- Node.js 20+
- AWS CDK CLI (`npm install -g aws-cdk`)
- Basic knowledge of TypeScript
- AWS Account (can be done within free tier)
- Basic understanding of VPC concepts (refer to [Episode 3: VPC Basics](https://dev.to/aws-builders/aws-cdk-100-drill-exercises-003-vpc-basics-from-network-configuration-to-security-4ddd))

## Project Directory Structure

```text
cdk-parameters/
├── bin/
│   └── cdk-parameters.ts                # Application entry point
├── lib/
│   ├── stacks/
│   │   ├── cdk-ts-parameters-stack.ts   # TypeScript parameters stack
│   │   └── cdk-json-parameters-stack.ts # cdk.json parameters stack
│   └── types/
│       ├── common.ts                     # Common type definitions
│       ├── vpc.ts                        # VPC type definitions
│       └── index.ts                      # Type definitions export
├── parameters/
│   ├── environments.ts                   # Environment definitions and parameter interfaces
│   ├── dev-params.ts                     # Development environment parameters
│   ├── stg-params.ts                     # Staging environment parameters
│   ├── prd-params.ts                     # Production environment parameters
│   └── index.ts                          # Parameter exports
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts              # Compliance tests
│   ├── snapshot/
│   │   └── snapshot.test.ts             # Snapshot tests
│   └── unit/
│       ├── cdk-ts-parameters-stack.test.ts # Unit tests
│       └── cdk-json-parameters-stack.test.ts
├── cdk.json                              # CDK configuration and JSON parameters
├── package.json
└── tsconfig.json
```

## Pattern 1: Defining Parameters in TypeScript Files

### Creating Type Definitions

First, define the types for parameters. This enables IDE autocomplete and compile-time type checking.

```typescript
// lib/types/index.ts
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export enum Environment {
  DEVELOPMENT = 'dev',
  STAGING = 'stg',
  PRODUCTION = 'prd',
  TEST = 'test',
}

export interface SubnetConfig {
  subnetType: ec2.SubnetType;
  name: string;
  cidrMask: number;
}

export interface VpcCreateConfig {
  vpcName?: string;
  cidr: string;
  maxAzs?: number;
  natCount?: number;
  enableDnsHostnames?: boolean;
  enableDnsSupport?: boolean;
  subnets?: SubnetConfig[];
}

export interface VpcConfig {
  existingVpcId?: string;
  createConfig?: VpcCreateConfig;
}
```

**Key Points:**

- Detailed type definitions like `SubnetConfig` and `VpcCreateConfig` prevent configuration mistakes
- Using `enum` for environment names prevents typos
- Optional properties (`?`) allow for default value usage

### Environment-Specific Parameter Files

Create parameter files for each environment.

```typescript
// parameters/environments.ts
export interface EnvParams {
    accountId: string;
    vpcConfig: VpcConfig;
}

export const params: Record<Environment, EnvParams> = {} as Record<Environment, EnvParams>;
```

```typescript
// parameters/dev-params.ts
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as types from 'lib/types';
import { params, EnvParams } from 'parameters/environments';

const devParams: EnvParams = {
    accountId: '111122223333',  // Development environment AWS Account ID
    vpcConfig: {
        createConfig: {
            vpcName: 'DevVPC',
            cidr: '10.10.0.0/16',
            maxAzs: 2,              // Only 2 AZs for development
            natCount: 1,            // Only 1 NAT for cost savings
            enableDnsHostnames: true,
            enableDnsSupport: true,
            subnets: [
                {
                    subnetType: ec2.SubnetType.PUBLIC,
                    name: 'Public',
                    cidrMask: 24,
                },
                {
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                    name: 'Private',
                    cidrMask: 24,
                },
            ],
        },
    },
};

// Register in global params object
params[types.Environment.DEVELOPMENT] = devParams;
```

```typescript
// parameters/prd-params.ts
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as types from 'lib/types';
import { params, EnvParams } from 'parameters/environments';

const prdParams: EnvParams = {
    accountId: '999988887777',  // Production environment AWS Account ID
    vpcConfig: {
        createConfig: {
            vpcName: 'PrdVPC',
            cidr: '10.0.0.0/16',
            maxAzs: 3,              // 3 AZs for redundancy in production
            natCount: 3,            // NAT Gateway in each AZ
            enableDnsHostnames: true,
            enableDnsSupport: true,
            subnets: [
                {
                    subnetType: ec2.SubnetType.PUBLIC,
                    name: 'Public',
                    cidrMask: 24,
                },
                {
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                    name: 'Private',
                    cidrMask: 24,
                },
            ],
        },
    },
};

params[types.Environment.PRODUCTION] = prdParams;
```

**Key Points:**

- Different configurations for development and production (number of AZs, NAT Gateways)
- Including account ID prevents deployment to wrong accounts
- Type safety detects configuration errors at compile time

### Stack Using Parameters

```typescript
// lib/stacks/cdk-parameters-stack.ts
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { VpcConfig, Environment } from 'lib/types';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { pascalCase } from 'change-case-commonjs';

export interface StackProps extends cdk.StackProps {
  project: string;
  environment: Environment;
  isAutoDeleteObject: boolean;
  vpcConfig: VpcConfig;
}

export class CdkTSParametersStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Reference existing VPC
    if (props.vpcConfig.existingVpcId) {
      this.vpc = ec2.Vpc.fromLookup(this, 'VPC', {
        vpcId: props.vpcConfig.existingVpcId,
      });
      return;
    }

    // Create new VPC
    if (props.vpcConfig.createConfig) {
      const createConfig = props.vpcConfig.createConfig;
      const vpcNameSuffix = createConfig.vpcName ?? 'vpc';
      
      this.vpc = new ec2.Vpc(this, 'VPC', {
        vpcName: `${pascalCase(props.project)}/${pascalCase(props.environment)}/${pascalCase(vpcNameSuffix)}`,
        ipAddresses: ec2.IpAddresses.cidr(createConfig.cidr),
        maxAzs: createConfig.maxAzs || cdk.Stack.of(this).availabilityZones.length,
        natGateways: createConfig.natCount || 1,
        subnetConfiguration: createConfig.subnets || [
          // Default subnet configuration
          {
            subnetType: ec2.SubnetType.PUBLIC,
            name: 'Public',
            cidrMask: 24,
          },
          {
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            name: 'Private',
            cidrMask: 24,
          },
        ],
        enableDnsHostnames: createConfig.enableDnsHostnames ?? true,
        enableDnsSupport: createConfig.enableDnsSupport ?? true,
      });
    } else {
      throw new Error('VPC configuration is required to create the VPC.');
    }
  }
}
```

**Key Points:**

- Type-safe parameter passing through `VpcConfig` interface
- Supports both existing VPC reference and new creation
- Default values allow operation with minimal parameters

### Entry Point and Deployment Validation

```typescript
// bin/cdk-parameters.ts
#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { pascalCase } from "change-case-commonjs";
import { params } from "parameters/environments";
import { CdkParametersStage } from 'lib/stages/cdk-parameters-stage';
import { Environment } from 'lib/types/common';
import { validateDeployment } from '@common/helpers/validate-deployment';
import 'parameters';

const app = new cdk.App();

const pjName: string = app.node.tryGetContext("project");
const envName: Environment = 
app.node.tryGetContext("env") || Environment.DEVELOPMENT;

const defaultEnv = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
};

// Check for parameter existence
if (!params[envName]) {
throw new Error(`No parameters found for environment: ${envName}`);
}

// Pre-deployment validation
validateDeployment(pjName, envName, params[envName].accountId);

const isAutoDeleteObject = true;
const isTerminationProtection = false;

new CdkParametersStage(app, `${pascalCase(envName)}`, {
    project: pjName,
    environment: envName,
    env: defaultEnv,
    terminationProtection: isTerminationProtection,
    isAutoDeleteObject: isAutoDeleteObject,
    params: params[envName],
});

cdk.Tags.of(app).add("Project", pjName);
cdk.Tags.of(app).add("Environment", envName);
```

**Deployment Validation Implementation:**

```typescript
// common/helpers/validate-deployment.ts
export function validateDeployment(
  pjName: string, 
  envName: string, 
  accountId?: string
): void {
  console.log(`Project Name: ${pjName}`);
  console.log(`Environment Name: ${envName}`);
  
  // Account ID validation
  if (accountId) {
    const isSameAccount = accountId === process.env.CDK_DEFAULT_ACCOUNT;
    if (!isSameAccount) {
      const warningBox = [
        '',
        '╭────────────────────────────────────────────────────────────╮',
        '│ ❌ ACCOUNT MISMATCH WARNING                                │',
        '│                                                            │',
        '│  The provided account ID does not match the current        │',
        '│  CDK account.                                              │',
        '│                                                            │',
        `│  Expected: ${accountId}                                    │`,
        `│  Current:  ${process.env.CDK_DEFAULT_ACCOUNT}              │`,
        '│                                                            │',
        '╰────────────────────────────────────────────────────────────╯',
        '',
      ].join('\n');
      console.log(warningBox);
      throw new Error('Account ID mismatch. Deployment aborted.');
    }
  }

  // Production environment deployment confirmation
  if (envName === 'prd') {
    const cautionBox = [
      '',
      '╭────────────────────────────────────────────────────────────╮',
      '│ 🚨 PRODUCTION DEPLOYMENT                                   │',
      '│                                                            │',
      '│  This is a production release.                             │',
      '│  Please review carefully before proceeding.                │',
      '│                                                            │',
      '╰────────────────────────────────────────────────────────────╯',
      '',
    ].join('\n');
    console.log(cautionBox);
    
    const readlineSync = require('readline-sync');
    const answer = readlineSync.question(
      'Are you sure you want to proceed? (yes/no): '
    );
    
    if (answer.toLowerCase() !== 'yes') {
      throw new Error('Deployment aborted by user.');
    }
    console.log('✓ Proceeding with deployment...');
  }
}
```

**Key Points:**

- Account ID validation prevents deployment to wrong accounts
- Requires user confirmation before production deployment
- Visually clear box display

### Deployment Method

```bash
# Deploy to development environment
npm run stage:deploy:all --project=myproject --env=dev

# Deploy to production environment (with confirmation prompt)
npm run stage:deploy:all --project=myproject --env=prd
```

### Pros and Cons of TypeScript Approach

**Pros:**

- Type Safety: Detect configuration errors at compile time
- IDE Support: Autocomplete and refactoring
- Complex Logic: Easy parameter calculation and conditional branching
- Reusability: Share common type definitions across multiple stacks
- Version Control: Track parameter changes with Git

**Cons:**

- Recompilation on Changes: Build required every time parameters change
- Initial Setup: Type definitions and file structure preparation needed
- Learning Cost: TypeScript knowledge required

## Pattern 2: Defining Parameters in cdk.json

### Parameter Definition in cdk.json

```json
// cdk.json
{
  "app": "npx ts-node --prefer-ts-exts bin/cdk-parameters.ts",
  "context": {
    "dev": {
      "vpcConfig": {
        "createConfig": {
          "vpcName": "DevVPC",
          "cidr": "10.100.0.0/16",
          "maxAzs": 2,
          "natCount": 1,
          "enableDnsHostnames": true,
          "enableDnsSupport": true,
          "subnets": [
            {
              "subnetType": "PUBLIC",
              "name": "Public",
              "cidrMask": 24
            },
            {
              "subnetType": "PRIVATE_WITH_NAT",
              "name": "Private",
              "cidrMask": 24
            }
          ]
        }
      }
    },
    "stg": {
      "vpcConfig": {
        "createConfig": {
          "vpcName": "StgVPC",
          "cidr": "10.101.0.0/16",
          "maxAzs": 2,
          "natCount": 2
        }
      }
    },
    "prd": {
      "vpcConfig": {
        "createConfig": {
          "vpcName": "PrdVPC",
          "cidr": "10.0.0.0/16",
          "maxAzs": 3,
          "natCount": 3
        }
      }
    }
  }
}
```

**Key Points:**

- Define environment-specific parameters in JSON
- Use CDK's standard `context` section
- Configuration changes possible without recompilation

### Stack Using cdk.json Parameters

```typescript
// lib/stacks/cdk-json-parameters-stack.ts
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { Environment } from 'lib/types';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { pascalCase } from 'change-case-commonjs';

export interface StackProps extends cdk.StackProps {
  project: string;
  environment: Environment;
  isAutoDeleteObject: boolean;
}

export class CdkJsonParametersStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Get parameters from cdk.json
    const params = this.node.tryGetContext(props.environment) || {};
    const vpcConfig = params['vpcConfig'] || {};

    // Reference existing VPC
    if (vpcConfig['existingVpcId']) {
      this.vpc = ec2.Vpc.fromLookup(this, "VPC", {
        vpcId: vpcConfig['existingVpcId'],
      });
      return;
    }

    // Check for createConfig existence
    if (!vpcConfig['createConfig']) {
      throw new Error(
        'VPC createConfig is required in JSON parameters to create the VPC.'
      );
    }
    
    const createConfig = vpcConfig['createConfig'];
    
    // Subnet configuration mapping
    const subnets = createConfig['subnets'] || [
      {
        subnetType: 'PUBLIC',
        name: 'Public',
        cidrMask: 24,
      },
      {
        subnetType: 'PRIVATE_WITH_NAT',
        name: 'Private',
        cidrMask: 24,
      }
    ];
    
    // Create VPC
    const vpcNameSuffix = createConfig['vpcName'] ?? 'vpc';
    this.vpc = new ec2.Vpc(this, "VPC", {
      vpcName: `${pascalCase(props.project)}/${pascalCase(props.environment)}/${pascalCase(vpcNameSuffix)}`,
      ipAddresses: ec2.IpAddresses.cidr(
        createConfig['cidr'] || '10.1.0.0/16'
      ),
      maxAzs: createConfig['maxAzs'] || 3,
      natGateways: createConfig['natCount'] || 1,
      subnetConfiguration: subnets.map((subnet: any) => {
        // Convert string subnetType to ec2.SubnetType
        if (subnet['subnetType'] === 'PUBLIC') {
          return {
            subnetType: ec2.SubnetType.PUBLIC,
            name: subnet['name'] || 'Public',
            cidrMask: subnet['cidrMask'] || 24,
          };
        } else if (subnet['subnetType'] === 'PRIVATE_WITH_NAT') {
          return {
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            name: subnet['name'] || 'Private',
            cidrMask: subnet['cidrMask'] || 24,
          };
        }
        return null;
      }).filter((config: any) => config !== null),
    });
  }
}
```

**Key Points:**

- Retrieve values from cdk.json using `this.node.tryGetContext()`
- Convert string-type parameters to TypeScript types
- Default values allow operation with minimal parameters
- Type checking performed at runtime

### Pros and Cons of cdk.json Approach

**Pros:**

- No Recompilation: Deploy immediately after parameter changes
- CDK Standard: Standard CDK approach
- External Tool Integration: Easy to read with JSON parsers
- Low Learning Cost: Only JSON knowledge required
- Dynamic Values: Retrieve and calculate values at runtime

**Cons:**

- No Type Safety: Cannot detect configuration errors until runtime
- Limited IDE Support: No autocomplete or refactoring
- Complex Logic: Difficult to perform calculations or conditional branching
- Error Handling: Runtime error handling required

## Which Approach Should You Choose?

### Approach Comparison Table

| Aspect | TypeScript Approach | cdk.json Approach |
|--------|---------------------|-------------------|
| **Type Safety** | ✅ Compile-time type checking | ❌ Cannot detect until runtime |
| **IDE Support** | ✅ Autocomplete and refactoring | ⚠️ Limited |
| **Ease of Change** | ⚠️ Recompilation required | ✅ No recompilation needed |
| **Complex Logic** | ✅ Easy calculation and conditional branching | ❌ Difficult |
| **External Tool Integration** | ⚠️ Build required | ✅ Easy with JSON parser |
| **Learning Cost** | ⚠️ TypeScript knowledge required | ✅ JSON only |
| **Initial Setup** | ⚠️ Type definitions and file structure needed | ✅ Simple |
| **Version Control** | Change history is clear | Change history is clear |
| **Error Detection** | ✅ Compile-time | ❌ Runtime |
| **CDK Standard** | ⚠️ Custom approach | ✅ CDK standard |

### Recommended Use Cases

#### TypeScript Approach Recommended

- Large projects (many parameters and complex configurations)
- When type safety is important
- Team development (IDE support improves development efficiency)
- Complex logic (parameter calculations and conditional branching)
- Long-term operation (maintainability and readability focused)

#### cdk.json Approach Recommended

- Small projects (simple configurations)
- When rapid changes are needed
- CDK beginners (limited TypeScript knowledge)
- CI/CD integration (configuration changes from external tools)
- Prototyping (rapid experimentation and validation)

### Hybrid Approach

In production, combining both approaches can be effective.

- Basic Configuration: Managed in cdk.json (environment name, region, etc.)
- Complex Configuration: Managed in TypeScript (VPC configuration, security groups, etc.)
- Sensitive Information: Retrieved from AWS Secrets Manager

```typescript
// Example of hybrid approach
const envName = app.node.tryGetContext("env"); // from cdk.json
const params = await getParametersFromTypeScript(envName); // from TypeScript
const secrets = await getSecretsFromSecretsManager(); // from Secrets Manager
```

## Test Implementation

The same test patterns can be applied to both approaches.

### Unit Tests

```typescript
// test/unit/cdk-parameters-stack.test.ts
describe("CdkTSParametersStack Fine-grained Assertions", () => {
  let stackTemplate: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new CdkTSParametersStack(app, "CdkParameters", {
      project: "TestProject",
      environment: Environment.TEST,
      env: { account: '123456789012', region: 'ap-northeast-1' },
      isAutoDeleteObject: true,
      terminationProtection: false,
      vpcConfig: {
        createConfig: {
          vpcName: "TestVPC",
          cidr: "10.1.0.0/16",
          maxAzs: 2,
          natCount: 1,
          subnets: [
            { subnetType: ec2.SubnetType.PUBLIC, name: 'Public', cidrMask: 24 },
            { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, name: 'Private', cidrMask: 24 },
          ],
        },
      },
    });
    stackTemplate = Template.fromStack(stack);
  });

  test("should create 1 VPC", () => {
    stackTemplate.resourceCountIs("AWS::EC2::VPC", 1);
  });

  test("VPC should have correct CIDR block", () => {
    stackTemplate.hasResourceProperties("AWS::EC2::VPC", {
      CidrBlock: "10.1.0.0/16",
    });
  });
});
```

### Snapshot Tests

```typescript
// test/snapshot/snapshot.test.ts
describe("Stack Snapshot Tests", () => {
  const app = new cdk.App({ context: testContext });

  // Create all stacks first
  const stack = new CdkTSParametersStack(app, "CdkParameters", {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    terminationProtection: false,
    vpcConfig: envParams.vpcConfig,
  });

  const jsonParameterStack = new CdkJsonParametersStack(
    app, "CdkJsonParameters", {
    project: projectName,
    environment: envName,
    env: defaultEnv,
    isAutoDeleteObject: true,
    terminationProtection: false,
  });

  // Get templates after all stacks are created
  const stackTemplate = Template.fromStack(stack);
  const jsonParameterStackTemplate = Template.fromStack(jsonParameterStack);

  test("Complete CloudFormation template snapshot", () => {
    expect(stackTemplate.toJSON()).toMatchSnapshot();
    expect(jsonParameterStackTemplate.toJSON()).toMatchSnapshot();
  });
});
```

**Key Points:**

- Create all stacks before calling `Template.fromStack()`
- Use same test patterns for both approaches
- Snapshot tests detect unintended changes

## Deployment and Cleanup

### Deployment

```bash
# Deploy TypeScript parameters version
npm run stage:deploy:all --project=myproject --env=dev

# Deploy cdk.json parameters version
npm run stage:deploy:all --project=myproject --env=dev
```

### Cleanup

```bash
# Delete all resources
npm run stage:destroy:all --project=myproject --env=dev
```

## Summary

In this exercise, we learned two major approaches for managing parameters in CDK.

### What We Learned

1. TypeScript Approach: Development efficiency through type safety and IDE support
2. cdk.json Approach: Flexibility and rapid changes
3. Deployment Validation: Account ID checking and production environment confirmation
4. Test Strategy: Test patterns applicable to both approaches
5. Best Practices: Choosing based on project size

### Best Practices

1. Leverage Type Definitions: Make full use of TypeScript's type system
2. Default Values: Set default values for non-required parameters
3. Implement Validation: Implement parameter validation before deployment
4. Documentation: Clearly document parameter meanings and constraints
5. Testing: Implement tests for parameter changes

## Reference Resources

- [AWS CDK Documentation - Context Values](https://docs.aws.amazon.com/cdk/v2/guide/context.html)
- [AWS CDK Best Practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)

