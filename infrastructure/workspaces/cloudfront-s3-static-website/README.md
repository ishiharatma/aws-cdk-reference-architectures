# XXXX

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

## **Sorry!Under construction!!**

## Architecture Overview

![overview](overview.drawio.svg)

- xxxx
- xxxx

### Key Components

- xxxx
- xxxx

## Deploy

```bash
export PROJECT=your-project
export ENV=dev

npm run bootstrap   # first time only
npm run diff
npm run stage:deploy:all
```

### WAF allowed IPs (v4/v6)

This workspace's CloudFront distribution has a WAFv2 Web ACL attached. By default, only the global IP of the machine running `cdk deploy` is added to the post-managed-rules allowlist (`bin/cloudfront-s3-static-website.ts` auto-detects it via `curl`). IPv6 is attempted via `curl -6` and silently skipped when unavailable (e.g. devcontainers/CI without IPv6 egress), in which case only the IPv4 address is allowed.

To allow specific IPs instead of auto-detection (e.g. the IP of the machine where you actually open the browser), set the `ALLOWED_IPS` / `ALLOWED_IPV6S` environment variables (comma-separated for multiple values). When set, the auto-detection `curl` call is skipped entirely.

```bash
ALLOWED_IPS=203.0.113.10,203.0.113.20 \
ALLOWED_IPV6S=2001:db8::1 \
npm run stage:deploy:all
```

If neither is set nor auto-detected, the WAF IP restriction falls back to "allow all".

## Usage

## Clean-up

## 料金

[XXXX - AWS 料金見積りツール](https://calculator.aws/#/estimate?id=XXXX)