# API Gateway + S3 Stub API - AWS CDK Reference Architecture

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **Level: 200 (Intermediate)**

A mock/stub HTTP API built entirely from an Amazon API Gateway REST API wired directly to Amazon S3 via an **AWS Service integration** -- no Lambda function anywhere in the request path. Every HTTP method reads a canned JSON file from S3 (`s3:GetObject`); extending the API is just dropping a new file into the bucket, no redeploy required. Useful as a lightweight fake backend for frontend development, contract testing, or demos where a full backend isn't ready yet.

Based on the pattern described in [「API Gateway + S3でとりあえず動くAPIスタブを作ってみた」](https://zenn.dev/issy/articles/zenn-apigw-s3-stub-tried-it).

## 📑 Table of Contents

- [Architecture Overview](#-architecture-overview)
- [Design Decisions & Best Practices](#-design-decisions--best-practices)
- [Cost Optimization](#-cost-optimization)
- [Security Considerations](#-security-considerations)
- [Prerequisites](#-prerequisites)
- [Deployment Guide](#-deployment-guide)
- [Usage](#usage)
- [Testing Strategy](#-testing-strategy)
- [Customization](#-customization)
- [Troubleshooting](#-troubleshooting)
- [Clean-up](#-clean-up)
- [References](#-references)

## 🏗️ Architecture Overview

![Architecture Diagram](overview.drawio.svg)

### Key Components

- **Amazon API Gateway (REST API)** -- exposes `/{resource}` and `/{resource}/{item}` resources. Every method (`GET`/`POST` on the collection, `GET`/`PUT`/`DELETE` on the item) is an **AWS Service (non-proxy) integration**, not `AWS_PROXY` and not `HTTP_PROXY`. The integration's backend HTTP method is always `GET` -- the caller's HTTP verb only selects *which* file to read.
- **Amazon S3 (`StubBucket`)** -- holds the canned JSON responses. Object keys follow `<resource>/<method>_result.json` (collection) or `<resource>/<item>/<method>_result.json` (item), e.g. `users/get_result.json`, `users/1/put_result.json`.
- **IAM Role (`ApiGatewayS3Role`)** -- assumed by API Gateway to call `s3:GetObject` on the bucket's objects and `s3:ListBucket` on the bucket itself; no other permissions are granted. `ListBucket` is required for a missing stub file to come back as a real `404` (see [Design Decision 2](#2-http-method-to-s3-key-mapping-via-path-override)) -- without it, S3 masks "not found" as `403 AccessDenied`.
- **S3 BucketDeployment** -- seeds a couple of example resources (`users`, `orders`) at deploy time so the API is immediately testable. `prune: false`, so stub files you add by hand later (console/CLI) survive redeploys.
- **API Key + Usage Plan** -- every method requires `x-api-key`, throttled per the environment's `throttle` parameter (default 10 req/s, burst 20).

### Architecture Characteristics

| Characteristic | Value | Rationale |
|---------------|-------|-----------|
| Availability | Regional, AWS-managed | API Gateway and S3 are both regional managed services with built-in multi-AZ durability; no infrastructure to operate. |
| Scalability | Scales to S3/API Gateway service limits | No compute (Lambda/EC2) in the request path, so there is no concurrency bottleneck to size for. |
| Security | API key + least-privilege IAM | The integration role can only `s3:GetObject`/`s3:ListBucket` on this one bucket; the bucket blocks all public access and requires TLS. |
| Cost | Pay-per-request, near-zero at rest | No idle compute cost; storage is a handful of KB of JSON. |

## 🎯 Design Decisions & Best Practices

### 1. AWS Service integration instead of Lambda

**Decision**: Use API Gateway's native `AWS` (non-proxy) integration type to call `s3:GetObject` directly, instead of a Lambda function that reads from S3 and returns the body.

**Rationale**:
- ✅ Zero compute to write, test, deploy, or patch -- the "backend" is a JSON file
- ✅ No cold starts; latency is API Gateway + S3 only
- ✅ Extending the API (new resource, new example) is a file upload, not a code change/redeploy
- ✅ Nothing to scale -- no concurrency limits to reason about

**Trade-offs**:
- ❌ No request logic (validation beyond path-parameter presence, conditional responses, computed fields) -- it is a *static* stub, not a mock server with behavior
- ❌ Every distinct response needs its own object; there's no templating across many similar responses beyond what VTL response templates can express
- ❌ Debugging AWS-type integrations is less familiar than debugging Lambda code (CloudWatch execution logs are the primary tool)

### 2. HTTP method to S3 key mapping via path override

**Decision**: Every method's integration path is a literal template such as `<bucket>/{resource}/get_result.json`, with `{resource}`/`{item}` populated from the request's path parameters via `integration.request.path.*` mappings. The S3-side HTTP method is **always `GET`** (`integrationHttpMethod: 'GET'`) regardless of the caller's verb -- the verb is baked into the *file name*, not passed through to S3.

```typescript
const integration = new apigateway.AwsIntegration({
  service: 's3',
  integrationHttpMethod: 'GET',
  path: `${stubBucket.bucketName}/{resource}/get_result.json`,
  options: {
    credentialsRole: apiGatewayS3Role,
    requestParameters: {
      'integration.request.path.resource': 'method.request.path.resource',
    },
    integrationResponses: [
      { statusCode: '200' },
      { statusCode: '403', selectionPattern: '403' },
      { statusCode: '404', selectionPattern: '404' },
    ],
  },
});
```

**Rationale**:
- ✅ Adding a new HTTP method for a resource is one `addMethod()` call pointing at a new file -- the routing logic stays in CDK, the response data stays in S3
- ✅ `selectionPattern: '404'` lets a missing stub file surface as a real `404` instead of a `200` with an S3 XML error body

**Gotcha found via `test-api.sh` against a real deployment**: a missing stub file first came back as `200` with a raw S3 `AccessDenied` XML body, not a clean `404`. The cause is an S3 behavior, not an API Gateway one: without `s3:ListBucket` on the bucket, S3 can't tell "this object doesn't exist" from "you can't see this bucket at all" and returns `403 AccessDenied` for both, regardless of whether the object is actually missing (see [S3 access control troubleshooting](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-troubleshooting.html)). Since the only `integrationResponses` entries were `200` (default) and `404`, that `403` matched neither `selectionPattern` and fell through to the default `200`. The fix has two parts: grant `apiGatewayS3Role` an `s3:ListBucket` statement scoped to the bucket (not just `s3:GetObject` on its objects) so S3 returns genuine `404`s, *and* add an explicit `403` entry to `integrationResponses`/`methodResponses` so a real permission error still surfaces as an error instead of silently matching the `200` catch-all.

**Environment-Specific Configuration**: throttling is tunable per environment via `EnvParams.throttle` (see [`parameters/dev-params.ts`](parameters/dev-params.ts)):

```typescript
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  throttle: { rateLimit: 10, burstLimit: 20 },
};
```

### 3. API key instead of IAM/Cognito authorization

**Decision**: Every method sets `apiKeyRequired: true` and is associated with a `UsagePlan`, instead of IAM (SigV4) or a Cognito/Lambda authorizer.

**Rationale**:
- ✅ Keeps the "just curl it" developer experience that makes a stub API useful in the first place -- no SigV4 signing or user pool to set up just to hit a fake endpoint
- ✅ Still gives request throttling and per-key usage tracking, which is enough for a shared dev/CI stub
- ❌ An API key is **not** a real authentication mechanism (it identifies a caller for throttling/billing, not for authorization) -- do not reuse this pattern for an API serving real data

**Well-Architected Alignment**:

| Pillar | Implementation |
|--------|---------------|
| **Operational Excellence** | Access logs (JSON, standard fields) on the API stage; no compute to patch/monitor for runtime errors. |
| **Security** | Least-privilege IAM role (`s3:GetObject` + `s3:ListBucket`, one bucket only), TLS-only bucket, blocked public access, API key + usage plan throttling. |
| **Reliability** | Fully managed services (API Gateway, S3) with no single points of failure introduced by this stack. |
| **Performance Efficiency** | Direct service integration avoids Lambda cold starts; S3 read latency is typically single-digit milliseconds. |
| **Cost Optimization** | No idle compute; pay only per request and for a few KB of S3 storage. |
| **Sustainability** | No over-provisioned compute sitting idle between requests. |

## 💰 Cost Optimization

### Estimated Monthly Costs (ap-northeast-1 / Tokyo)

#### Light usage (personal/dev, ~10,000 requests/month)
```
API Gateway REST API:  10,000 req x $4.25 / 1,000,000       = $0.04
S3 GET requests:       10,000 req x $0.00037 / 1,000        = $0.004
S3 storage:            < 1 MB of JSON                        ≈ $0.00
CloudWatch Logs:       < 10 MB access logs                   ≈ $0.00
-------------------------------------------------------------------
Total:                                                       ~$0.05/month
```

#### Shared/CI usage (~1,000,000 requests/month)
```
API Gateway REST API:  1,000,000 req x $4.25 / 1,000,000    = $4.25
S3 GET requests:       1,000,000 req x $0.00037 / 1,000     = $0.37
S3 storage:            < 1 MB of JSON                         ≈ $0.00
CloudWatch Logs:       ~200 MB access logs x $0.76/GB        = $0.15
-------------------------------------------------------------------
Total:                                                       ~$4.77/month
```

*(Pricing as of 2026, ap-northeast-1; excludes any free-tier allowance. Verify current rates with the [AWS Pricing Calculator](https://calculator.aws/).)*

### Cost Optimization Strategies

1. **No Lambda in the request path**
   - Saves the per-invocation Lambda charge and any provisioned-concurrency cost entirely -- the request path is API Gateway -> S3 only.

2. **`RetentionDays.ONE_MONTH` on the API access log group**
   - Avoids unbounded CloudWatch Logs storage growth for a tool that is typically used for short-lived dev/test cycles.

3. **`prune: false` on `BucketDeployment`**
   - Avoids resynthesizing/re-uploading the seed data on every deploy when nothing changed (CDK still compares hashes, but there is no risk of the deployment scanning/deleting unrelated objects you added by hand).

## 🔒 Security Considerations

### Network & Data Security

1. **Least-privilege IAM role**
   - `ApiGatewayS3Role` is scoped to two actions on this one bucket only: `s3:GetObject` on `StubBucket/*`, and `s3:ListBucket` on the bucket itself (required so a missing stub file returns a real `404` instead of S3 masking it as `403 AccessDenied` -- see [Design Decision 2](#2-http-method-to-s3-key-mapping-via-path-override)). No `PutObject`, `DeleteObject`, or any other bucket-level action is granted.

2. **S3 bucket hardening**
   - `blockPublicAccess: BLOCK_ALL`, `enforceSSL: true`, SSE-S3 encryption by default.

3. **API key + usage plan throttling**
   - Every method requires `x-api-key` and is throttled (default 10 req/s, burst 20), limiting abuse of a publicly reachable stub endpoint.

### Security Best Practices Implemented

- ✅ No public S3 access -- the bucket is only reachable through the API Gateway integration role
- ✅ TLS enforced on the S3 bucket (`enforceSSL: true`)
- ✅ API Gateway access logging enabled (JSON, standard fields) for auditability
- ✅ Request validation enabled (`validateRequestParameters: true`) so malformed requests are rejected by API Gateway before reaching the integration

### What this stack intentionally does *not* do

This is a mock/stub API for local prototyping, not a production data API:
- No IAM/Cognito authorization on the methods (see [Design Decision 3](#3-api-key-instead-of-iamcognito-authorization))
- No WAF association (demonstrated separately in the `cloudfront-vpc-origin` workspace)

Both are documented and suppressed with a reason in [`test/compliance/cdk-nag.test.ts`](test/compliance/cdk-nag.test.ts) -- do not copy those suppressions into an architecture that serves real user data.

### CDK Nag Compliance

```bash
npm run test:compliance -w workspaces/apigw-s3-stub
```

## 📋 Prerequisites

- AWS Account with appropriate permissions
- AWS CLI v2.x installed and configured
- Node.js 20.x or later
- AWS CDK 2.x
- Git

### Required IAM Permissions

The deploying user/role needs permissions to create/manage:
- API Gateway (REST API, resources, methods, deployments, API keys, usage plans)
- S3 (bucket, bucket policy, objects)
- IAM (role, inline policy for the API Gateway S3 role)
- CloudWatch Logs (log group for API access logs)
- Lambda (the CDK-managed custom resource used by `BucketDeployment` to seed example files)

## 🚀 Deployment Guide

### 1. Clone and Setup

```bash
cd infrastructure
npm install
```

### 2. Configure Environment Parameters

Edit [`parameters/dev-params.ts`](parameters/dev-params.ts) if you want to change the region or throttling limits:

```typescript
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  throttle: { rateLimit: 10, burstLimit: 20 },
};
```

### 3. Deploy

`PROJECT`/`ENV` feed both the CDK context (`-c project=... -c env=...`) and the expected AWS CLI profile name (`${PROJECT}-${ENV}`, e.g. `apigw-s3-stub-dev`) baked into this workspace's npm scripts.

```bash
export PROJECT=apigw-s3-stub
export ENV=dev

npm run bootstrap -w workspaces/apigw-s3-stub   # first time only, per account/region
npm run synth -w workspaces/apigw-s3-stub
npm run deploy:all -w workspaces/apigw-s3-stub
```

### 4. Verify Deployment

The stack outputs `ApiUrl`, `StubBucketName`, and `ApiKeyId`. Fetch the actual API key value (it is never printed in plaintext by CloudFormation):

```bash
aws apigateway get-api-key --api-key <ApiKeyId> --include-value --query value --output text
```

Or run [`test-api.sh`](test-api.sh), which resolves all three outputs itself and exercises every method (collection/item GET/POST/PUT/DELETE, the 404 path for a missing stub file, the 403 path for a missing API key) plus a live demo of extending the API via S3:

```bash
./test-api.sh --project $PROJECT --env $ENV
```

## Usage

```bash
API_URL="<ApiUrl output>"
API_KEY="$(aws apigateway get-api-key --api-key <ApiKeyId> --include-value --query value --output text)"

# GET /users -> reads users/get_result.json
curl -s -H "x-api-key: $API_KEY" "${API_URL}users" | jq .

# POST /users -> reads users/post_result.json
curl -s -X POST -H "x-api-key: $API_KEY" "${API_URL}users" | jq .

# GET /users/1 -> reads users/1/get_result.json
curl -s -H "x-api-key: $API_KEY" "${API_URL}users/1" | jq .

# PUT /users/1 -> reads users/1/put_result.json
curl -s -X PUT -H "x-api-key: $API_KEY" "${API_URL}users/1" | jq .

# DELETE /users/1 -> reads users/1/delete_result.json
curl -s -X DELETE -H "x-api-key: $API_KEY" "${API_URL}users/1" | jq .
```

### Extending the API with a new stub

No redeploy needed -- just add an object to `StubBucketName` at the expected key:

```bash
echo '{"id":"42","name":"New Widget"}' \
  | aws s3 cp - "s3://<StubBucketName>/widgets/get_result.json" --content-type application/json

curl -s -H "x-api-key: $API_KEY" "${API_URL}widgets" | jq .
```

## 🧪 Testing Strategy

### Test Structure

```
test/
├── compliance/
│   └── cdk-nag.test.ts     # AWS Solutions cdk-nag checks + documented suppressions
├── snapshot/
│   └── snapshot.test.ts    # Full template snapshot + resource-count snapshot
└── unit/
    └── apigw-s3-stub.test.ts  # Bucket, IAM role, integrations, methods, usage plan, outputs
```

### 1. Snapshot Tests

**Purpose**: Catch unintended CloudFormation template changes during refactoring.

```bash
npm run test:snapshot -w workspaces/apigw-s3-stub
```

### 2. Unit Tests

**Purpose**: Assert on the specific resources and configuration that make this pattern work.

**Test Categories** (10 tests):
- ✅ Core resources (S3 bucket hardening, REST API, IAM role/policy, BucketDeployment) (4 tests)
- ✅ AWS Service integrations (non-proxy `AWS` type, GET/POST/PUT/DELETE routing, `apiKeyRequired`) (3 tests)
- ✅ Usage plan and throttling (API key/usage plan resources, stage access logging) (2 tests)
- ✅ Outputs (`ApiUrl`, `StubBucketName`, `ApiKeyId`) (1 test)

```bash
npm run test:unit -w workspaces/apigw-s3-stub
```

### 3. Compliance Tests

```bash
npm run test:compliance -w workspaces/apigw-s3-stub
```

## ⚙️ Customization

### Adding a new HTTP method to an existing resource level

```typescript
addStubMethod(resource, 'PATCH', '{resource}/patch_result.json', ['resource']);
```

Then seed the corresponding file via `BucketDeployment` (or upload it directly to S3 after deploy).

### Changing throttling per environment

```typescript
// parameters/dev-params.ts
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  throttle: { rateLimit: 50, burstLimit: 100 },
};
```

### Restricting CORS origins

By default `defaultCorsPreflightOptions` allows all origins (`apigateway.Cors.ALL_ORIGINS`), convenient for local frontend development. Restrict it for a shared/team deployment:

```typescript
defaultCorsPreflightOptions: {
  allowOrigins: ['https://your-frontend.example.com'],
  allowMethods: apigateway.Cors.ALL_METHODS,
},
```

## 🔧 Troubleshooting

### Issue: `403 Forbidden` from every request

**Symptoms**: All requests fail with `{"message":"Forbidden"}` regardless of path.

**Solutions**:
1. Confirm the `x-api-key` header is set and matches the value from `aws apigateway get-api-key --include-value`.
2. Confirm the deployment stage is included in the usage plan (`UsagePlanKey`/`addApiStage` -- already wired in this stack, but check if you customized it).

### Issue: `404` for a path you expect to work

**Symptoms**: `{"message":"No stub file found for this path/method"}`.

**Solutions**:
1. Check the object exists at the exact expected key: `<resource>/<method>_result.json` or `<resource>/<item>/<method>_result.json`.
2. List the bucket contents: `aws s3 ls s3://<StubBucketName>/ --recursive`.
3. Confirm the object's IAM/bucket policy allows `s3:GetObject` by the `ApiGatewayS3Role` (unmodified from this stack, this is already granted).

### Issue: A missing stub file returns `200` with a raw S3 XML `AccessDenied` body, not a clean `404`

**Symptoms**: `GET`ing a path with no corresponding stub file returns HTTP `200` with an `<Error><Code>AccessDenied</Code>...` XML body, instead of the friendly `404` JSON message.

**Cause**: S3 returns `403 AccessDenied` (not `404 NoSuchKey`) for `GetObject` on a missing key whenever the caller lacks `s3:ListBucket` on the bucket -- this is intentional S3 behavior so a caller can't distinguish "object doesn't exist" from "you can't see this bucket" (see [S3 access control troubleshooting](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-troubleshooting.html)). `ApiGatewayS3Role` already grants `s3:ListBucket`, so a stock deployment of this stack won't hit this -- but if you copy this pattern and trim the role down to `s3:GetObject` only, this is exactly what you'll see.

**Solutions**:
1. Grant `s3:ListBucket` on the bucket (not just `s3:GetObject` on its objects) to the integration role.
2. Check `integrationResponses`/`methodResponses` on the method include entries for both `403` and `404` (`selectionPattern: '403'`/`'404'`; already present for every method in this stack) -- without a `403` entry, any AccessDenied response falls through to the default `200` branch and leaks the raw S3 XML body.
3. Enable `loggingLevel: INFO` (already enabled) and inspect the API's CloudWatch Logs execution logs for the exact S3 status code returned.
4. `test-api.sh` exercises this exact path (`GET /users/999`, `GET /no-such-resource`) and is what caught this in the first place -- run it after any IAM changes.

## 🧹 Clean-up

```bash
npm run destroy:all -w workspaces/apigw-s3-stub
```

`isAutoDeleteObject: true` (set in [`bin/apigw-s3-stub.ts`](bin/apigw-s3-stub.ts) for this reference architecture) empties `StubBucket` automatically so `cdk destroy` does not fail on a non-empty bucket.

## 📚 References

### AWS Documentation
- [Set up an AWS service integration for a REST API in API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/getting-started-aws-integration.html)
- [Amazon API Gateway API request and response data mapping reference](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-mapping-template-reference.html)
- [Amazon S3 GetObject API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)

### AWS Well-Architected
- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)

### AWS CDK
- [aws-apigateway module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_apigateway-readme.html)
- [aws-s3-deployment module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3_deployment-readme.html)

### Related Architectures
- [sns-basic](../sns-basic/) -- another API Gateway example, this time `LambdaIntegration` fronting SNS HTTPS subscription confirmations
- [cloudfront-vpc-origin](../cloudfront-vpc-origin/) -- shows WAF association with an API Gateway-backed distribution

### Original Article
- [「API Gateway + S3でとりあえず動くAPIスタブを作ってみた」(Zenn)](https://zenn.dev/issy/articles/zenn-apigw-s3-stub-tried-it) -- the pattern this reference architecture is based on

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](../../LICENSE) file for details.

## 👥 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](../../CONTRIBUTING.md) for details.

## 🏆 About This Reference Architecture

This reference architecture demonstrates AWS CDK best practices for building production-ready infrastructure.

**Target Level**: 200 (Intermediate)

---

**Note**: This is a reference implementation. Always review and customize according to your specific requirements and organizational policies before deploying to production. This particular pattern is designed for mock/stub use cases, not for serving real production data.
