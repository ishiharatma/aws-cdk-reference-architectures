# S3 Static Web Site — S3 Website Hosting with an IP-Restricted Bucket Policy

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-100-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-S3-orange?style=flat-square)

## Introduction

This is a reference implementation of the simplest possible way to publish a static website on AWS: an S3 bucket configured for **S3 static website hosting**, served directly from its website endpoint — no CloudFront, no CDN, no custom domain.

This architecture demonstrates:

- S3 static website hosting (`websiteIndexDocument` / `websiteErrorDocument`) with **S3 Block Public Access fully enabled** on the bucket
- Restricting anonymous access to the website endpoint to a specific allow-list of IPv4/IPv6 addresses via a bucket policy scoped with `aws:SourceIp` — a condition S3 recognizes as non-public, so it coexists with Block Public Access
- Auto-detecting the deploying operator's own global IP (falling back to explicit `ALLOWED_IPS`/`ALLOWED_IPV6S` environment variables) so a fresh `cdk deploy` is immediately viewable by whoever ran it
- A dedicated S3 server-access-log bucket, separate from the website content bucket
- Optional content upload via `BucketDeployment`, so the stack can also be deployed with an empty bucket

### Why this pattern?

| Feature | Benefit |
| ------- | ------- |
| No CloudFront, no WAF, no ACM certificate | The fastest, cheapest way to get a static site online — useful as a baseline before reaching for [`cloudfront-s3-static-website`](../cloudfront-s3-static-website/) |
| IP allow-list compatible with Block Public Access | Demonstrates that a bucket policy is only "public" (and therefore blocked) in S3's eyes when it lacks a recognized restrictive condition — `aws:SourceIp` is one such condition, so `BlockPublicAccess.BLOCK_ALL` and a source-IP-scoped public policy can coexist |
| Auto-detected operator IP | `bin/s3-static-web-site.ts` calls `curl` to discover the deploying machine's own IP, so the freshly deployed site is viewable immediately without a manual bucket-policy edit |

## Architecture Overview

![overview](overview.drawio.svg)

### Key Components

| Component | Design Points |
| --------- | -------------- |
| `WebsiteBucket` | `createAccountRegionalBucketWebSite` — `websiteIndexDocument: 'index.html'`, `websiteErrorDocument: 'error.html'`, `blockPublicAccess: BLOCK_ALL`, `enforceSSL: false` (the S3 website endpoint only serves plain HTTP, so `enforceSSL` cannot be enabled on this bucket) |
| `AccessLogBucket` | Receives S3 server access logs for `WebsiteBucket` (prefix `website-bucket-logs/`); `accessControl: LOG_DELIVERY_WRITE` + `objectOwnership: BUCKET_OWNER_PREFERRED`, both required for S3's log delivery service to write into it |
| Bucket policy (conditional) | Added only when `allowedIps`/`allowedIpv6s` is non-empty: `Effect: Allow`, `Principal: *`, `Action: s3:GetObject`, scoped with `Condition: { IpAddress: { aws:SourceIp: [...] } }` |
| `BucketDeployment` (conditional) | Only created when `contentsPath` is supplied; `bin/s3-static-web-site.ts` points it at `frontend/static-web/` |

## Data Flow

```text
Browser
  │  HTTP (S3 website endpoints do not support HTTPS)
  ▼
S3 Bucket Website Endpoint (<bucket>.s3-website-<region>.amazonaws.com)
  │  Evaluated against the bucket policy: source IP must match allowedIps/allowedIpv6s
  ▼
index.html / error.html (from WebsiteBucket)
```

Every request is anonymous — the website endpoint does not support SigV4 authentication — so the *only* access control available at this layer is the bucket policy's `aws:SourceIp` condition. There is no edge/CDN layer here to add geo restriction, WAF rules, or caching; that is exactly what [`cloudfront-s3-static-website`](../cloudfront-s3-static-website/) adds on top of this same idea.

## Design Decisions & Best Practices

### 1. `enforceSSL: false` is intentional, not an oversight

**Decision**: Unlike every other bucket in this repository, `WebsiteBucket` is created with `enforceSSL: false`.

**Rationale**:
- ✅ S3 static website hosting endpoints (`*.s3-website-<region>.amazonaws.com`) only serve plain HTTP — there is no HTTPS listener to enforce SSL against. Setting `enforceSSL: true` here would make the bucket policy deny the very (HTTP) requests the website endpoint receives, breaking the site entirely.

**Trade-offs**:
- ❌ Traffic between the browser and the website endpoint is unencrypted. If HTTPS is required, front the bucket with CloudFront instead — see [`cloudfront-s3-static-website`](../cloudfront-s3-static-website/), which uses a private (non-website) bucket, Origin Access Control, and TLS termination at the edge.

### 2. IP allow-listing while keeping Block Public Access fully enabled

**Decision**: `WebsiteBucket` keeps `blockPublicAccess: BlockPublicAccess.BLOCK_ALL` (via the shared `createAccountRegionalBucketWebSite` helper) even though its bucket policy grants `s3:GetObject` to `Principal: *`.

**Rationale**:
- ✅ S3's Block Public Access evaluation does not treat every `Principal: *` statement as "public" — a statement restricted by one of a specific set of condition keys, including `aws:SourceIp`, is excluded from that classification. That is what makes `BlockPublicPolicy: true` and this IP-scoped policy compatible.
- ✅ If `allowedIps`/`allowedIpv6s` were both omitted, no bucket policy is added at all, and the site would return `403 Access Denied` to everyone — there is no "allow all" fallback in this stack (contrast with the WAF stack in [`cloudfront-s3-static-website`](../cloudfront-s3-static-website/), which *does* default open when no IPs are configured).

**Trade-offs**:
- ❌ `bin/s3-static-web-site.ts` calls `getMyGlobalIp()`, which **throws** if it can't reach `checkip.amazonaws.com` — unlike the CloudFront WAF stack's IPv6 helper, there is no silent "skip and allow all" fallback for IPv4 here. A deploy from a fully offline machine will fail unless `ALLOWED_IPS` is set explicitly.

## Cost Optimization

### Estimated Monthly Costs (ap-northeast-1, low traffic)

```
S3 storage (a few MB of static content)                  < $0.01
S3 requests (GET, low volume)                             < $0.01
S3 server access logging storage                          < $0.01
-------------------------------------------------------------------
Total                                                      < $0.05/month
```

> There is no CloudFront, WAF, or compute in this stack — cost is essentially just S3 storage and request pricing.

## Security Considerations

- ✅ `blockPublicAccess: BLOCK_ALL` stays enabled at all times; access is only possible through the explicit, IP-scoped bucket policy statement
- ✅ Both IPv4 (`/32`) and IPv6 (`/128`) allow-lists are supported and applied as separate, independent policy statements
- ⚠️ Traffic to the website endpoint is plain HTTP — anyone able to observe network traffic between the allow-listed IP and S3 can read the response in cleartext. Do not use this pattern for anything beyond a local/demo static site.
- ⚠️ An `aws:SourceIp`-restricted policy is still evaluated per-request, not per-session — it is IP allow-listing, not authentication. It's suitable for demos and personal use, not for restricting access to a specific individual.

## Prerequisites

- AWS Account with appropriate permissions
- AWS CLI v2.x installed and configured
- Node.js 20.x or later
- AWS CDK 2.x
- Git

### Required IAM Permissions

The deploying user/role needs permissions to create/manage:
- S3 (buckets, bucket policies)

## Deployment Guide

### 1. Clone and Setup

```bash
git clone <this-repository>
cd infrastructure
npm install
```

### 2. Deploy

```bash
export PROJECT=your-project
export ENV=dev

npm run bootstrap   # first time only
npm run diff
npm run stage:deploy:all
```

### Allowed IPs (v4/v6)

By default, only the global IP of the machine running `cdk deploy` is added to the bucket policy allow-list (`bin/s3-static-web-site.ts` auto-detects it via `curl`). IPv6 is attempted via `curl -6` and silently skipped when unavailable (e.g. devcontainers/CI without IPv6 egress); IPv4 detection failure, by contrast, makes the deploy **fail** — there is no "allow all" fallback for this stack.

To allow specific IPs instead of auto-detection (e.g. the IP of the machine where you actually open the browser), set the `ALLOWED_IPS` / `ALLOWED_IPV6S` environment variables (comma-separated for multiple values). When set, the auto-detection `curl` call is skipped entirely.

```bash
ALLOWED_IPS=203.0.113.10,203.0.113.20 \
ALLOWED_IPV6S=2001:db8::1 \
npm run stage:deploy:all
```

### 3. Verify Deployment

```bash
aws cloudformation describe-stacks \
  --stack-name <ProjectName>S3StaticWebSite \
  --query 'Stacks[0].Outputs'
```

```bash
curl http://<WebsiteBucketUrl-from-output>/
```

## Usage

Open `WebsiteBucketUrl` (from the stack outputs) in a browser from an allow-listed IP. Requests from any other IP receive `403 Forbidden`.

## Testing

```bash
npm test -w workspaces/s3-static-web-site              # all tests
npm run test:unit -w workspaces/s3-static-web-site      # unit tests
npm run test:snapshot -w workspaces/s3-static-web-site  # snapshot tests
```

> `test/compliance/cdk-nag.test.ts` in this workspace is still the unfilled project template (it references a placeholder `YoutStackName` type) and does not currently run against `S3StaticWebSiteStack` — see [`cloudfront-s3-static-website`](../cloudfront-s3-static-website/)'s compliance test for a filled-in example of the same template.

## Customization

### Uploading your own content

Point `contentsPath` (set in [`lib/stages/s3-static-web-site-stage.ts`](./lib/stages/s3-static-web-site-stage.ts)) at a different local directory, or replace the files under `frontend/static-web/`. If `contentsPath` is omitted, the bucket deploys empty.

### Removing the IP restriction

Passing empty arrays for both `allowedIps` and `allowedIpv6s` skips the bucket policy entirely — but since `blockPublicAccess: BLOCK_ALL` stays on, the site becomes inaccessible to everyone rather than becoming open to the public. To make the site genuinely public, the bucket's public access block configuration itself would need to change (not recommended for this reference implementation — use [`cloudfront-s3-static-website`](../cloudfront-s3-static-website/) for a properly public, HTTPS-served site instead).

## Clean-up

```bash
export PROJECT=your-project
export ENV=dev
npm run stage:destroy:all
```

## Troubleshooting

### Issue: `cdk deploy` fails with "Could not retrieve global IP address"

**Symptoms**: The deploy fails before synthesis with an error thrown from `getMyGlobalIp()`.

**Solutions**:
1. Check that the deploying machine can reach `http://checkip.amazonaws.com` (no outbound internet access, or a proxy blocking it, are the usual causes)
2. Set `ALLOWED_IPS` explicitly to skip auto-detection entirely: `ALLOWED_IPS=203.0.113.10 npm run stage:deploy:all`

### Issue: Browser shows `403 Forbidden` after a successful deploy

**Symptoms**: The stack deploys cleanly, but opening `WebsiteBucketUrl` returns an XML `AccessDenied` error.

**Solutions**:
1. Confirm the browser's current public IP matches what was allow-listed at deploy time (dynamic IPs and VPNs are common causes of mismatch) — check the stack's CloudFormation events or re-run with `ALLOWED_IPS` set to the correct value and redeploy
2. Remember the site is HTTP-only — some browsers/extensions silently upgrade to HTTPS and then fail against the website endpoint; try the exact `http://` URL from the stack output

## References

### AWS Documentation
- [Hosting a static website using Amazon S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteHosting.html)
- [Blocking public access to your Amazon S3 storage](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html)
- [Bucket policy examples — IP address condition](https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-bucket-policies.html#example-bucket-policies-use-case-3)

### AWS CDK
- [aws-s3-deployment module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3_deployment-readme.html)

### Related Architectures
- [`cloudfront-s3-static-website`](../cloudfront-s3-static-website/) — the HTTPS, CloudFront + WAF evolution of this same idea
- [`cicd-cloudfront-s3`](../cicd-cloudfront-s3/) — a CI/CD pipeline that deploys content into a CloudFront/S3 site

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](../../../LICENSE) file for details.

## 👥 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](../../../docs/contribution/CONTRIBUTING.md) for details.

## 🏆 About This Reference Architecture

This reference architecture demonstrates the simplest AWS CDK path to a static website, and the S3 Block Public Access behavior that makes an IP-restricted public bucket policy possible.

**Target Level**: 100 (Beginner)

---

**Note**: This is a reference implementation. Always review and customize according to your specific requirements and organizational policies before deploying to production.
