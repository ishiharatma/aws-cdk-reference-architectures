# aws-cdk-reference-architectures

![cover](/cover.png)

AWS Reference Architectures implemented with CDK - Collection of cloud architecture patterns and best practices with practical examples using AWS CDK

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

## Overview

This repository provides reference architectures for AWS implemented using AWS Cloud Development Kit (CDK). Each architecture pattern includes detailed documentation, architecture diagrams, and CDK implementation in TypeScript/Python.

## Getting Started

### Prerequisites

- Node.js 20.x or later
- AWS CLI configured with appropriate credentials
- AWS CDK CLI installed (`npm install -g aws-cdk`)

This reference architecture requires creating an AWS profile named `project-env` (where project and env are passed as CDK command arguments) before running CDK commands.

#### AWS Configuration Examples

**Using AWS IAM Identity Center:**

```sh
# ~/.aws/config
[sso-session my-session]
sso_start_url = https://d-956745f993.awsapps.com/start/
sso_region = ap-northeast-1
sso_registration_scopes = sso:account:access

[profile project-env]
sso_session = my-session
sso_account_id = 123456789012
sso_role_name = YourRoleName
region = ap-northeast-1
output = json
```

**Using IAM User with MFA (Assume Role):**

```sh
# ~/.aws/config
[profile project-env]
source_profile = project-env-accesskey
role_arn = arn:aws:iam::123456789012:role/YourRoleName
mfa_serial = arn:aws:iam::123456789012:mfa/yourdevicename
region = ap-northeast-1
output = json
```

```sh
# ~/.aws/credentials
[project-env-accesskey]
aws_access_key_id = xxxxxxxxxx
aws_secret_access_key = xxxxxxxxxx
```

**Using IAM User with MFA (Direct Permissions):**

```sh
# ~/.aws/config
[profile project-env]
source_profile = project-env-accesskey
mfa_serial = arn:aws:iam::123456789012:mfa/yourdevicename
region = ap-northeast-1
output = json
```

```sh
# ~/.aws/credentials
[project-env-accesskey]
aws_access_key_id = xxxxxxxxxx
aws_secret_access_key = xxxxxxxxxx
```

**Using Temporary Credentials:**

```sh
# ~/.aws/config
[profile project-env]
aws_access_key_id = xxxxxxxxxx
aws_secret_access_key = xxxxxxxxxx
aws_session_token = xxxxxxxxxx
```

### Installation

1. Clone the repository

```bash
git clone https://github.com/ishiharatma/aws-cdk-reference-architectures.git
```

2. Install dependencies

```bash
cd aws-cdk-reference-architectures/infrastructure/cdk
npm install
```

## Repository Structure

```text
aws-cdk-reference-architectures/
├── docs/                                    # Documentation Root Folder
├── scripts/                                 # Workspace Initialize Scripts
├── templates/                               # Workspace templates
├── infrastructure/
│   └─── cdk/                                # CDK project root folder
│       ├── common                           # Common
│       └── workspaces                       # CDK Workspace
│           └──<pattern-name>
│               ├── bin/                     # CDK app entry point
│               ├── lib/                     # 
│               |   ├── aspects/             # CDK Aspects
│               |   ├── constructs/          # Custom constructs
│               |   ├── stacks/              # CDK stacks
│               |   ├── stages/              # CDK stages
│               |   └── types/               # Type definitions
|               ├── src/                     # Source files
|               ├── parameters/              # Environment Parameters
|               └── test/                    # Tests
│                   ├── compliance/          # Compliance Tests
│                   ├── integration/         # Integration Tests
│                   ├── helpers/             # Helper functions for tests
│                   ├── snapshot/            # Snapshot Tests
│                   ├── unit/                # Fine-grained assertions Tests
│                   └── validation/          # Validation Tests
│
```

## Available Architecture Patterns

Each architecture pattern includes:

1. Detailed documentation explaining the architecture
2. Architecture diagrams (draw.io and exported images)
3. CDK implementation with deployment instructions
4. Cost considerations and operational guidelines

## Development

### Working with CDK Workspaces

This project uses a workspace structure based on [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces).

Initialize the workspace using the provided shell script:

```sh
./scripts/init-cdk.sh infrastructure/cdk-workspaces
```

### Deployment Instructions

1. Install dependencies for all workspaces

```bash
cd infrastructure/cdk-workspaces
npm install
```

2. Build all CDK apps

```bash
npm run build
```

3. Deploy a specific CDK app

```bash
npm run deploy -w workspaces/serverless --project=example --env=dev
```

The deployment command uses npm workspaces with project and environment parameters to select the appropriate AWS profile (e.g., `example-dev` for project=example and env=dev).

### CDK App Development

Each CDK app in the workspace follows this structure:

```text
workspaces/<pattern-name>/
├── bin/                         # CDK app entry point
|   └── <pattern-name>.ts        #
├── lib/                         # 
|   ├── aspects/                 # CDK Aspects
|   ├── constructs/              # Custom constructs
|   ├── stacks/                  # CDK stacks
|   |   └── <pattern-name>-stack.ts
|   ├── stages/                  # CDK stages
|   |   └── <pattern-name>-stage.ts
|   └── types/                   # Type definitions
├── src/                         # Source files
├── parameters/                  # Environment Parameters
├── test/                        # Tests
├── cdk.json                     # CDK configuration
└── package.json                 # Dependencies
```

### Adding a New CDK App

To add a new workspace to the CDK project, use the provided script:

```bash
./scripts/add-usecase.sh s3-basics
```

This will create a new CDK app with the standard structure and configurations.

## Contributing

We welcome contributions! Please see our [Contributing Guide](docs/contribution/CONTRIBUTING.md) for details.

## License

This project is licensed under the Apache License, Version 2.0 - see the [LICENSE](LICENSE) file for details.

## Support & Feedback

Please file an issue if you have any questions, feedback, or feature requests.
