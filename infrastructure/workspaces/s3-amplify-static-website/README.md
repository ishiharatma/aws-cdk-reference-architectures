# S3 + Amplify Static Website Hosting

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-200-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-S3%20%7C%20Amplify-orange?style=flat-square)

## Introduction

This architecture demonstrates how to host a static website using **AWS Amplify Hosting**.

Key differences compared to the CloudFront + S3 pattern:

| Aspect | CloudFront + S3 | **S3 + Amplify Hosting** |
|--------|----------------|--------------------------|
| CDN | Self-managed | Managed by Amplify |
| Deployment | `BucketDeployment` | zip uploaded via S3 |
| Custom domain | Requires Route 53 + ACM | Configurable in Amplify console |
| Branch previews | None | Pull-request preview support |

This pattern uses Amplify Hosting's **manual deployment mode** (no Git repository connection). Website source files are packaged as a CDK asset, uploaded to S3, and pulled into Amplify via the `StartDeployment` API.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  During cdk deploy                                       │
│                                                         │
│  1. CDK Asset → zip → CDK Bootstrap S3 bucket           │
│  2. Amplify service role → S3 read permission granted   │
│  3. AWS::Amplify::App + Branch created                  │
│  4. Custom resource (Lambda) → calls StartDeployment    │
│     sourceUrl = s3://<bootstrap-bucket>/<hash>.zip      │
│                                                         │
│  On user access                                         │
│                                                         │
│  User → Amplify Hosting CDN → Static content delivered  │
└─────────────────────────────────────────────────────────┘
```

**Deployment flow:**

1. Run `cdk deploy`
2. CDK zips the website directory and uploads it to the CDK Bootstrap S3 bucket (content-hash key)
3. IAM permissions are granted so the Amplify service role can read the zip
4. CloudFormation creates `AWS::Amplify::App` and `AWS::Amplify::Branch`
5. A custom resource (Lambda) calls `amplify:StartDeployment`
6. Amplify fetches and extracts the zip, then serves content via its managed CDN

**On content update:**

When website files change, the CDK asset's hash key changes, which changes the `sourceUrl`. The next `cdk deploy` automatically triggers a fresh Amplify deployment.

## Project Directory Structure

```text
s3-amplify-static-website/
├── bin/
│   └── s3-amplify-static-website.ts   # Application entry point
├── lib/
│   ├── stacks/
│   │   └── s3-amplify-static-website-stack.ts  # Stack definition
│   └── stages/
│       └── s3-amplify-static-website-stage.ts  # Stage definition
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts
│   ├── snapshot/
│   │   └── snapshot.test.ts
│   └── unit/
│       └── s3-amplify-static-website.test.ts
├── cdk.json
├── package.json
└── tsconfig.json
```

## Key Resource Explanations

### CDK Asset (`s3_assets.Asset`)

```typescript
const websiteAsset = new s3_assets.Asset(this, 'WebsiteAsset', {
  path: path.join(__dirname, '../../../../../frontend/static-web'),
});
```

CDK zips the website directory and uploads it to the CDK Bootstrap bucket. The key is a SHA-256 hash of the contents, so changing any file automatically generates a new key.

### Amplify Service Role

```typescript
const amplifyServiceRole = new iam.Role(this, 'AmplifyServiceRole', {
  assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
});
websiteAsset.grantRead(amplifyServiceRole);
```

The role Amplify uses to fetch the zip from S3 when `StartDeployment` runs.

### Amplify App

```typescript
this.amplifyApp = new amplify.CfnApp(this, 'AmplifyApp', {
  name: `${props.project}-${props.environment}-website`,
  platform: 'WEB',
  iamServiceRole: amplifyServiceRole.roleArn,
});
```

`platform: 'WEB'` means a static website with Amplify's managed CDN. Omitting `repository` and `accessToken` puts the app into **manual deployment mode**.

### Amplify Branch

```typescript
this.amplifyBranch = new amplify.CfnBranch(this, 'AmplifyBranch', {
  appId: this.amplifyApp.attrAppId,
  branchName: 'main',
  enableAutoBuild: false,
  enablePullRequestPreview: false,
});
```

`enableAutoBuild: false` disables Git-push triggered auto builds. Deployment is driven exclusively by the custom resource.

### Deployment Custom Resource

```typescript
const deployAction = {
  service: 'Amplify',
  action: 'startDeployment',
  parameters: {
    appId: this.amplifyApp.attrAppId,
    branchName,
    sourceUrl: `s3://${websiteAsset.s3BucketName}/${websiteAsset.s3ObjectKey}`,
    sourceUrlType: 'ZIP',
  },
  physicalResourceId: cr.PhysicalResourceId.of(
    `${props.project}-${props.environment}-amplify-deploy`,
  ),
};

new cr.AwsCustomResource(this, 'AmplifyDeployment', {
  onCreate: deployAction,
  onUpdate: deployAction,  // re-deploys automatically when sourceUrl changes
  policy: cr.AwsCustomResourcePolicy.fromStatements([
    new iam.PolicyStatement({
      actions: ['amplify:StartDeployment'],
      resources: ['*'],
    }),
  ]),
});
```

`AwsCustomResource` acts as a CloudFormation custom resource and calls `amplify:StartDeployment` on stack create (`onCreate`) and whenever properties change (`onUpdate`).

## Prerequisites

- AWS CLI v2 installed and configured
- Node.js 20 or later
- AWS CDK CLI (`npm install -g aws-cdk`)
- CDK Bootstrap complete (`cdk bootstrap`)
- Basic knowledge of TypeScript

## Deploy

```bash
# Check differences
npm run diff -- --project=sample --env=dev

# Deploy (approx. 5–10 minutes)
npm run deploy:all -- --project=sample --env=dev
```

After deployment, open the `AmplifyAppUrl` output to view your website.

### Updating Content

Edit files under `frontend/static-web/` and run `cdk deploy` again. The CDK asset hash changes, and Amplify is redeployed automatically.

```bash
npm run deploy:all -- --project=sample --env=dev
```

## Cleanup

```bash
npm run destroy:all -- --project=sample --env=dev
```

> **Note**: Deleting the stack removes the Amplify App and all its deployments.

## When to Use This Pattern vs CloudFront + S3

| Use case | Recommended pattern |
|----------|---------------------|
| Full customization (WAF, geo-restriction, etc.) | CloudFront + S3 |
| Quick static site publishing | **S3 + Amplify Hosting** |
| Auto-deploy on Git push | Amplify Hosting (Git mode) |
| Backend API integration | CloudFront + VPC Origin |

## References

- [AWS Amplify Hosting Documentation](https://docs.aws.amazon.com/amplify/latest/userguide/welcome.html)
- [Amplify StartDeployment API](https://docs.aws.amazon.com/amplify/latest/APIReference/API_StartDeployment.html)
- [CDK aws-amplify module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_amplify-readme.html)
- [CDK s3-assets module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3_assets-readme.html)
