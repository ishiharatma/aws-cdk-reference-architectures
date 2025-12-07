# Development Container - Infrastructure Setup

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

## Overview

This dev container includes all the tools needed for CDK infrastructure setup and management.

## Prerequisites

- Docker or Docker daemon on WSL
- Visual Studio Code + Dev Containers extension
- `.aws/config` file must be placed in the project root directory

## Included Tools

- **Node.js & NPM**: JavaScript/TypeScript runtime environment
- **TypeScript**: TypeScript compiler (`tsc`)
- **ESLint**: Code quality checking tool
- **Git**: Source code management
- **AWS CLI**: Command-line tool for AWS resource management
- **AWS Session Manager Plugin**: Secure connection to EC2 instances
- **AWS CDK**: Infrastructure as Code framework
- **Docker CLI**: Container management and execution
- **UV & UVX**: Fast package manager

## AWS Authentication and Access

### Convenient Aliases

The container includes the following convenient AWS and NPM-related aliases:

- `tips`: Display alias list
- AWS related
  - `awslogin`: AWS SSO login with default profile
  - `awsid`: Check current authentication credentials
  - `awsloginp <profile-name>`: Login with specified profile
  - `awsidp <profile-name>`: Check credentials for specified profile
- NPM related
  - `npmfl`: Run formatting and lint fixes

### Usage Examples

```bash
# Login with default profile
awslogin

# Login as development environment administrator
awsloginp dev-admin

# Check current authentication credentials
awsid

# Check production environment credentials
awsidp prd-admin
```

## Important Notes

1. **AWS SSO Token Expiration**: AWS SSO tokens have an expiration date. If you see an expiration error, run `awslogin` or `awsloginp <profile-name>` to refresh the token.

2. **Secret Management**: Do not commit AWS credentials or secrets to the Git repository.

3. **Resource Management**: After using deployed AWS resources, properly delete them to avoid unnecessary costs.

4. **Docker in Docker**: Docker daemon is running inside this container. Use the Docker inside the container, not the host's Docker. Volumes and networks are isolated from the host.

5. **Pre-installed Tools**: The following tools are pre-installed and available on the PATH in this container:
   - Node.js & npm: For JavaScript application development
   - TypeScript & tsc: For TypeScript development
   - ESLint: For code quality management
   - Git: For source code management (latest version built from source)
   - AWS CLI & related tools: For AWS development
   - Docker CLI: For container management

## Troubleshooting

### AWS Authentication Error

If you encounter an AWS SSO login error:

```text
Error when retrieving token from sso: Token has expired and refresh failed
```

Solution: Run `awslogin` or `awsloginp <profile-name>` to refresh the token.

### Using Docker Commands

Notes when using Docker inside the container:

- Independent from the host machine's Docker
- Images and containers are not shared with the host
- Use `docker` commands normally, but the execution environment is inside the container

### Version Check

You can check the versions of tools included in the environment with the following commands:

```bash
node -v
npm -v
tsc --version
eslint --version
git --version
aws --version
session-manager-plugin --version
cdk --version
docker --version
uv --version
uvx --version
```
