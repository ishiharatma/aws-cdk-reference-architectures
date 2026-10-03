# S3 + Amplify Static Website Hosting — Manual-Deployment Amplify Hosting Fed from a CDK Asset

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 200](https://img.shields.io/badge/Level-200-blue?style=flat-square)

## Introduction

This reference implementation hosts a static website on **AWS Amplify Hosting** in **manual deployment mode** (no Git repository connection). The website source is packaged as a CDK asset, uploaded to the CDK bootstrap S3 bucket, and handed to Amplify through the `StartDeployment` API by a small custom-resource Lambda.

This architecture demonstrates:

- Amplify Hosting without a Git connection: a CDK asset zip is the deployment source
- A Lambda-backed custom resource that presigns the zip's S3 URL and calls `amplify:StartDeployment`, so no bucket policy on the shared CDK bootstrap bucket is needed
- Content-addressed redeployment: any change under `frontend/static-web/` changes the asset key and triggers a fresh Amplify deployment on the next `cdk deploy`
- An Amplify app with no `iamServiceRole`, because nothing in this design needs Amplify to call another AWS service on its own behalf
- Deploy-verified on 2026-09-27, including two defects the real deployment found and fixed; see [Deploy verification](#-deploy-verification)

### Why this pattern?

| Aspect | CloudFront + S3 | **S3 + Amplify Hosting** |
|--------|----------------|--------------------------|
| CDN | Self-managed | Managed by Amplify |
| Deployment | `BucketDeployment` | zip uploaded via S3 |
| Custom domain | Requires Route 53 + ACM | Configurable in the Amplify console |
| Branch previews | None | Pull-request preview support (disabled in this sample) |

## 📑 Table of Contents

- [Architecture Overview](#️-architecture-overview)
- [Design Decisions & Best Practices](#-design-decisions--best-practices)
- [Cost Optimization](#-cost-optimization)
- [Security Considerations](#-security-considerations)
- [Prerequisites](#-prerequisites)
- [Deployment Guide](#-deployment-guide)
- [Testing Strategy](#-testing-strategy)
- [Customization](#️-customization)
- [Deploy verification](#-deploy-verification)
- [Troubleshooting](#-troubleshooting)
- [When to Use This Pattern vs CloudFront + S3](#when-to-use-this-pattern-vs-cloudfront--s3)
- [References](#-references)

## 🏗️ Architecture Overview

![Architecture Overview](overview.drawio.svg)

### Key Components

| Component | Role |
|---|---|
| CDK Asset (`s3_assets.Asset`) | Zips `frontend/static-web/` and uploads it to the CDK bootstrap bucket. The key is a SHA-256 hash of the contents. |
| `AWS::Amplify::App` (`platform: 'WEB'`) | Static website with Amplify's managed CDN. No `repository` or `accessToken`, which puts the app into manual deployment mode. |
| `AWS::Amplify::Branch` | Branch `main` (configurable), auto build and pull-request preview disabled. |
| `AmplifyDeployHandler` (Node.js 22, arm64, 60 s) | Custom-resource Lambda: presigns a 15-minute GET URL for the zip and calls `amplify:StartDeployment`. |
| `cr.Provider` + `CustomResource` | Runs the handler on create and update. |

### Deployment Flow

1. `cdk deploy` zips the website directory and uploads it to the CDK bootstrap bucket (content-hash key).
2. CloudFormation creates `AWS::Amplify::App` and `AWS::Amplify::Branch`.
3. The custom resource invokes `AmplifyDeployHandler`, which generates a presigned S3 GET URL for the zip.
4. The handler calls `amplify:StartDeployment` with that URL as `sourceUrl`.
5. Amplify fetches the zip over plain HTTPS, extracts it, and serves the content from its managed CDN.

**On content update**: changed website files change the asset key, which changes the object the custom resource presigns. The next `cdk deploy` triggers a fresh Amplify deployment automatically.

### Architecture Characteristics

| Characteristic | Value | Rationale |
|---|---|---|
| Availability | Amplify-managed CDN | No origin or distribution to operate |
| Scalability | Managed by Amplify Hosting | Static content only |
| Security | HTTPS by default, no server-side compute | See [Security Considerations](#-security-considerations) |
| Cost | Storage + data served | See [Cost Optimization](#-cost-optimization) |

## 🎯 Design Decisions & Best Practices

### 1. Manual deployment mode instead of a Git connection

**Decision**: The Amplify app has no repository or access token, and the branch has `enableAutoBuild: false` and `enablePullRequestPreview: false`. Deployment is driven only by the custom resource.

**Rationale**:
- ✅ No Git provider token to store or rotate
- ✅ The same `cdk deploy` that changes infrastructure also publishes the content

**Trade-offs**:
- ❌ No push-triggered builds and no pull-request previews; use Amplify's Git mode when you need them

### 2. Presigned HTTPS URL instead of an `s3://` source URL

**Decision**: `AmplifyDeployHandler` presigns a short-lived HTTPS GET URL for the zip and passes it to `StartDeployment`.

**Rationale**:
- ✅ An `s3://` source URL requires a bucket policy that grants `amplify.amazonaws.com` read access ([Amplify guide](https://docs.aws.amazon.com/amplify/latest/userguide/deploy-with-sdks.html)). The zip lives in the shared CDK bootstrap bucket, which this stack does not own, and `websiteAsset.bucket` is an imported `IBucket`, so `addToResourcePolicy` on it silently does nothing.
- ✅ With a presigned URL Amplify performs a plain HTTP GET, so only the handler's own role needs `s3:GetObject` on the asset

**Trade-offs**:
- ❌ A Lambda and a `cr.Provider` to maintain, in place of a one-line SDK call

```typescript
// CDK zips the directory and uploads it to the bootstrap bucket (content-addressed key)
const websiteAsset = new s3_assets.Asset(this, 'WebsiteAsset', {
  path: path.join(__dirname, '../../../../../frontend/static-web'),
});

// The handler gets an ordinary identity-based read grant on the asset; no bucket policy is involved
websiteAsset.grantRead(deployHandler);
deployHandler.addToRolePolicy(
  new iam.PolicyStatement({ actions: ['amplify:StartDeployment'], resources: ['*'] }),
);

// Runs on create and update; the asset key changes only when the website files change
new cdk.CustomResource(this, 'AmplifyDeployment', {
  serviceToken: deployProvider.serviceToken,
  properties: {
    AppId: this.amplifyApp.attrAppId,
    BranchName: branchName,
    BucketName: websiteAsset.s3BucketName,
    ObjectKey: websiteAsset.s3ObjectKey,
  },
});
```

### 3. No `iamServiceRole` on the Amplify app

**Decision**: The app is created without a service role.

**Rationale**: Amplify fetches the zip through the presigned URL, and nothing else in this sample needs Amplify to call another AWS service on its behalf.

### 4. A Lambda-backed `cr.Provider`, not `cr.AwsCustomResource`

**Decision**: A real Lambda behind `cr.Provider` and `CustomResource`.

**Rationale**: `AwsCustomResource` bakes its `parameters` in as static JSON at synth time, so it cannot generate a presigned URL at deploy time.

### 5. Well-Architected Framework Alignment

| Pillar | Implementation |
|--------|---------------|
| **Operational Excellence** | One `cdk deploy` publishes both infrastructure and content; the deployment job status is visible with `aws amplify list-jobs` |
| **Security** | No bucket policy changes, no Amplify service role, a 15-minute presigned URL, HTTPS-only access to the site |
| **Reliability** | Amplify-managed CDN and hosting; content-addressed assets make redeployments deterministic |
| **Performance Efficiency** | Static content served from Amplify's managed CDN |
| **Cost Optimization** | No build minutes in manual mode; the deploy Lambda runs only on stack changes |
| **Sustainability** | Managed, shared hosting infrastructure with no idle compute of your own |

## 💰 Cost Optimization

### Estimated Monthly Costs (ap-northeast-1, small static site)

```text
Amplify Hosting storage:   stored GB × $0.023 / GB-month
Amplify Hosting transfer:  served GB × $0.15 / GB
Build minutes:             none (manual deployment mode runs no build)
AmplifyDeployHandler:      runs only when the stack changes; negligible
CDK bootstrap bucket:      the asset zip, a few KB to MB; negligible
```

These are Amplify Hosting's published list prices; check the [Amplify pricing page](https://aws.amazon.com/amplify/pricing/) for ap-northeast-1 and for the free tier. For a site of a few MB with modest traffic, storage and transfer are the whole bill.

### Cost Optimization Strategies

1. **Keep the asset small** — compress images and drop unused files; storage and transfer both scale with site size.
2. **Stay in manual deployment mode** — no builds are run, so no build minutes are billed.
3. **Destroy dev stacks when idle** — `npm run destroy:all` removes the Amplify app and its deployments.

## 🔒 Security Considerations

### Network Security

1. **Public by default** — the Amplify default domain serves the site to anyone who has the URL. Add authentication or a custom domain with your own controls if the content is not public.
2. **No VPC or inbound infrastructure** — the only compute is the deploy Lambda, which runs during `cdk deploy`.

### Security Best Practices Implemented

- ✅ The presigned URL expires after 900 seconds
- ✅ The handler role has an identity-based `s3:GetObject` grant scoped to the CDK bootstrap bucket and the asset key, plus `amplify:StartDeployment`
- ✅ No bucket policy is added to the shared bootstrap bucket, and the Amplify app has no service role
- ✅ `enableAutoBuild` and `enablePullRequestPreview` are off, so nothing deploys except through the stack

### CDK Nag Compliance

`test/compliance/cdk-nag.test.ts` runs `AwsSolutionsChecks` and documents each suppression:

- `AwsSolutions-IAM4`: `AWSLambdaBasicExecutionRole` on the handler and on the `cr.Provider` framework Lambda
- `AwsSolutions-IAM5`: the wildcards generated by `Asset.grantRead()` (scoped to the bootstrap bucket and asset key), the `amplify:StartDeployment` resource (the app ID is a token when the policy is attached), and the framework Lambda's invoke grant
- `AwsSolutions-L1`: the framework Lambda's runtime is managed by CDK; `AmplifyDeployHandler` runs `NODEJS_22_X`

```bash
npm run test:compliance -w workspaces/s3-amplify-static-website
```

## 📋 Prerequisites

- AWS CLI v2 installed and configured
- Node.js 20 or later
- AWS CDK CLI (`npm install -g aws-cdk`)
- CDK bootstrap completed (`cdk bootstrap`)
- Basic knowledge of TypeScript

## 🚀 Deployment Guide

### 1. Check the differences

```bash
npm run diff -- --project=sample --env=dev
```

### 2. Deploy (approx. 5–10 minutes)

```bash
npm run deploy:all -- --project=sample --env=dev
```

### 3. Verify

Open the `AmplifyAppUrl` output in a browser, or:

```bash
curl -I https://<branchName>.<app-default-domain>/
aws amplify list-jobs --app-id <AmplifyAppId> --branch-name main
```

### Updating Content

Edit files under `frontend/static-web/` and run `cdk deploy` again. The asset hash changes and Amplify redeploys automatically.

### Clean-up

```bash
npm run destroy:all -- --project=sample --env=dev
```

Deleting the stack removes the Amplify app and all of its deployments.

## 🧪 Testing Strategy

### Test Structure

```text
test/
├── compliance/        # cdk-nag AwsSolutionsChecks (3 tests)
├── snapshot/          # full template + resource counts (2 tests)
└── unit/              # fine-grained assertions (7 tests)
```

### 1. Snapshot Tests

**Purpose**: Detect unintended changes to the whole CloudFormation template.

```bash
npm run test:snapshot -w workspaces/s3-amplify-static-website
```

### 2. Unit Tests

**Purpose**: Assert the resources and relationships that make the pattern work.

- ✅ The Amplify app is created with the `WEB` platform and the branch has auto build disabled
- ✅ The deploy handler can read the CDK asset and call `amplify:StartDeployment`
- ✅ The deployment custom resource is backed by a `Provider` Lambda
- ✅ Outputs include `AmplifyAppId`, `AmplifyAppUrl`, and `AmplifyConsoleUrl`; a supplied `branchName` is used

```bash
npm test -w workspaces/s3-amplify-static-website
```

## ⚙️ Customization

### Use a different branch name

`branchName` is a stack property (default `main`). The branch resource, the custom resource, and the `AmplifyAppUrl` output all follow it.

### Add a custom domain

Configure it in the Amplify console, or add an `AWS::Amplify::Domain` resource to the stack.

### Move to Git-driven deployment

Add `repository` and an access token to the app and enable `enableAutoBuild`; drop the custom resource. This gives pull-request previews at the cost of managing the Git token.

## ✅ Deploy verification

Deployed to a real account (`ap-northeast-1`) on 2026-09-27, checked, then torn down. The deploy found two real bugs, both fixed here:

1. **`s3:GetObjectAcl` / `s3:PutObjectAcl` `AccessDenied`, then Amplify's own `"The bucket policy is either missing or has insufficient permissions"`.** The original design passed `sourceUrl: s3://<bootstrap-bucket>/<key>` straight to `amplify:StartDeployment`. That path needs a bucket policy granting `amplify.amazonaws.com` read access, but the zip lives in the shared CDK bootstrap bucket (`cdk-hnb659fds-assets-<account>-<region>`), which this stack does not own; `addToResourcePolicy` on the imported bucket silently does nothing. **Fix**: a presigned HTTPS GET URL generated at deploy time by `AmplifyDeployHandler` with its own `s3:GetObject` grant. None of `cdk synth`, the unit tests, or cdk-nag caught this; only the real `StartDeployment` call did.
2. A `cr.AwsCustomResource` cannot generate a presigned URL, because its `parameters` are static JSON fixed at synth time. The fix above therefore needed a real Lambda behind `cr.Provider` + `CustomResource`.

What was confirmed:

- `cdk deploy '**'` created the stack cleanly on the second attempt; the first attempt's `ROLLBACK_COMPLETE` state was cleaned up automatically by the next `cdk deploy`.
- `aws amplify list-jobs` showed the deployment job as `SUCCEED`.
- `curl https://main.<app-id>.amplifyapp.com/` returned a real `HTTP 200` with the actual `frontend/static-web/index.html` content, not just `CREATE_COMPLETE`.
- The stack was destroyed afterward and confirmed gone with `aws cloudformation describe-stacks`.

Not covered: a content update (a second deploy re-triggering Amplify through the changed asset hash) and a `branchName` other than `main`.

## 🔧 Troubleshooting

### Issue: `StartDeployment` fails with "The bucket policy is either missing or has insufficient permissions"

**Symptoms**: The custom resource fails and the stack rolls back.

**Solutions**:
1. Confirm `sourceUrl` is a presigned `https://` URL, not an `s3://` URL. An `s3://` URL requires a bucket policy you cannot add to the CDK bootstrap bucket.
2. Confirm the handler's role has `s3:GetObject` on the asset (`websiteAsset.grantRead`).

### Issue: The stack is stuck in `ROLLBACK_COMPLETE`

**Symptoms**: `cdk deploy` refuses to update the stack after a failed first deploy.

**Solutions**: Run `cdk deploy` again; the `ROLLBACK_COMPLETE` stack is deleted and recreated. If it persists, delete it with `aws cloudformation delete-stack`.

### Issue: The site shows old content after an update

**Symptoms**: `AmplifyAppUrl` still returns the previous files.

**Solutions**:
1. Confirm the files under `frontend/static-web/` actually changed (the asset key changes only then).
2. Check the latest job with `aws amplify list-jobs` and wait for `SUCCEED`.

## When to Use This Pattern vs CloudFront + S3

| Use case | Recommended pattern |
|----------|---------------------|
| Full customization (WAF, geo-restriction, etc.) | CloudFront + S3 |
| Quick static site publishing | **S3 + Amplify Hosting** |
| Auto-deploy on Git push | Amplify Hosting (Git mode) |
| Backend API integration | CloudFront + VPC Origin |

## 📚 References

### AWS Documentation

- [AWS Amplify Hosting](https://docs.aws.amazon.com/amplify/latest/userguide/welcome.html)
- [Deploying to Amplify Hosting with the SDKs](https://docs.aws.amazon.com/amplify/latest/userguide/deploy-with-sdks.html)
- [Amplify StartDeployment API](https://docs.aws.amazon.com/amplify/latest/APIReference/API_StartDeployment.html)

### AWS Well-Architected

- [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)

### AWS CDK

- [aws-amplify module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_amplify-readme.html)
- [aws-s3-assets module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3_assets-readme.html)
- [`cr.Provider`](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.custom_resources.Provider.html)

### Related Architectures

- [`cloudfront-s3-static-website`](../cloudfront-s3-static-website/) (the CloudFront + S3 alternative)

## 📄 License

This project is licensed under the Apache License, Version 2.0 - see the [LICENSE](../../../LICENSE) file for details.

## 👥 Contributing

Contributions are welcome! See the [Contribution Guide](../../../docs/contribution/CONTRIBUTING.md).

## 🏆 About This Reference Architecture

This reference architecture demonstrates AWS CDK best practices for hosting a static website on Amplify Hosting without a Git connection.

**Target Level**: 200 (Intermediate)

---

**Note**: This is a reference implementation. Always review and customize according to your specific requirements and organizational policies before deploying to production.
