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
┌───────────────────────────────────────────────────────────────┐
│  During cdk deploy                                             │
│                                                                 │
│  1. CDK Asset → zip → CDK Bootstrap S3 bucket                  │
│  2. AWS::Amplify::App + Branch created                         │
│  3. Custom resource (Lambda) → presigns a GET URL for the zip, │
│     then calls StartDeployment with that URL as sourceUrl      │
│                                                                 │
│  On user access                                                 │
│                                                                 │
│  User → Amplify Hosting CDN → Static content delivered          │
└───────────────────────────────────────────────────────────────┘
```

**Deployment flow:**

1. Run `cdk deploy`
2. CDK zips the website directory and uploads it to the CDK Bootstrap S3 bucket (content-hash key)
3. CloudFormation creates `AWS::Amplify::App` and `AWS::Amplify::Branch`
4. A custom resource (a small Lambda function, `AmplifyDeployHandler`) generates a presigned S3 GET URL for the zip and calls `amplify:StartDeployment` with it as `sourceUrl`
5. Amplify fetches the zip over plain HTTPS using that presigned URL, extracts it, and serves content via its managed CDN

**On content update:**

When website files change, the CDK asset's hash key changes, which changes the object the custom resource presigns. The next `cdk deploy` automatically triggers a fresh Amplify deployment.

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

### Amplify App

```typescript
this.amplifyApp = new amplify.CfnApp(this, 'AmplifyApp', {
  name: `${props.project}-${props.environment}-website`,
  platform: 'WEB',
});
```

No `iamServiceRole`: Amplify doesn't assume any role to fetch the zip in this design (see [Deployment Custom Resource](#deployment-custom-resource) below), and nothing else in this sample needs Amplify to call another AWS service on its behalf.

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
const deployHandler = new lambdaNodejs.NodejsFunction(this, 'AmplifyDeployHandler', {
  runtime: lambda.Runtime.NODEJS_22_X,
  architecture: lambda.Architecture.ARM_64,
  handler: 'handler',
  entry: path.join(__dirname, '../../src/lambda/amplify-deploy/index.ts'),
  timeout: cdk.Duration.seconds(60),
  bundling: { minify: true, sourceMap: true, target: 'node22' },
});
websiteAsset.grantRead(deployHandler);
deployHandler.addToRolePolicy(
  new iam.PolicyStatement({ actions: ['amplify:StartDeployment'], resources: ['*'] }),
);

const deployProvider = new cr.Provider(this, 'AmplifyDeployProvider', {
  onEventHandler: deployHandler,
});

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

Rather than passing an `s3://` URL directly to `amplify:StartDeployment` — which requires a **bucket policy** granting `amplify.amazonaws.com` read access (see [Amplify's own docs](https://docs.aws.amazon.com/amplify/latest/userguide/deploy-with-sdks.html)), impossible to attach here since the zip lives in the shared CDK bootstrap bucket this stack doesn't own — `AmplifyDeployHandler` (its own Lambda, fronted by a [`cr.Provider`](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.custom_resources.Provider.html)) presigns a short-lived HTTPS GET URL for the zip using its own `s3:GetObject` grant, then calls `amplify:StartDeployment` with that URL. Amplify just performs a plain HTTP GET, so no bucket policy or `iamServiceRole` is needed at all. Runs on both create and update (any content change produces a new asset key, so a fresh deployment is triggered automatically). See [Deploy verification](#deploy-verification) for why this replaced a simpler `cr.AwsCustomResource`-based first attempt.

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

## Deploy verification

Deployed to a real account (`ap-northeast-1`) on 2026-09-27, checked, then torn down. This deploy caught two real bugs — both fixed here, not just noted as caveats:

1. **`s3:GetObjectAcl` / `s3:PutObjectAcl` `AccessDenied`, then Amplify's own `"The bucket policy is either missing or has insufficient permissions"`.** The original design passed `sourceUrl: s3://<bootstrap-bucket>/<key>` straight to `amplify:StartDeployment`. That path requires the S3 bucket to carry a **bucket policy** granting `amplify.amazonaws.com` read access (documented in [Amplify's own guide](https://docs.aws.amazon.com/amplify/latest/userguide/deploy-with-sdks.html)) — but the zip lives in the shared CDK bootstrap bucket (`cdk-hnb659fds-assets-<account>-<region>`), which this stack doesn't own. `websiteAsset.bucket` is an imported `IBucket` (`Bucket.fromBucketAttributes` under the hood), so `addToResourcePolicy` on it is a silent no-op — there was no way to satisfy this from within the stack. **Fix**: replaced the direct `s3://` URL with a presigned HTTPS GET URL, generated at deploy time by a small Lambda (`AmplifyDeployHandler`) using its own `s3:GetObject` grant. Amplify then just performs a plain HTTP GET — no bucket policy, no `iamServiceRole`, needed at all. None of `cdk synth`, unit tests, or cdk-nag caught this; only the real `StartDeployment` call did.
2. A `cr.AwsCustomResource` (generic SDK-call custom resource) can't generate a presigned URL — its `parameters` are static JSON baked in at synth time. This forced a switch to a real Lambda-backed `cr.Provider` + `CustomResource`, which is why the diagrams and code samples above look different from a typical `AwsCustomResource` one-liner.

What was actually confirmed:

- `cdk deploy '**'` created the stack cleanly on the second attempt (the first attempt's `ROLLBACK_COMPLETE` state was cleaned up automatically by the next `cdk deploy`).
- `aws amplify list-jobs` showed the deployment job's status as `SUCCEED`.
- `curl https://main.<app-id>.amplifyapp.com/` returned a real `HTTP 200` with the actual `frontend/static-web/index.html` content — not just "the stack reached `CREATE_COMPLETE`."
- The stack was destroyed afterward and confirmed gone via `aws cloudformation describe-stacks`.

Not covered by this pass: a content update (second deploy re-triggering Amplify via the changed asset hash), and `branchName` other than the default `main`.

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
