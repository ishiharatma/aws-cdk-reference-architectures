# AWS WAF Body Inspection on CloudFront vs ALB — Verified Behavior

Deploy-verified in [`waf-php2shell-mitigation`](../../infrastructure/workspaces/waf-php2shell-mitigation/)
on 2026-10-22 (CloudFront Web ACL in us-east-1, ALB Web ACL in ap-northeast-1, patched PHP-FPM
origin on a Lambda container image behind the Lambda Web Adapter). The rules under test were the
PHP2Shell (CVE-2026-109618 / 109619) mitigation rules from the AWS Security Blog. Each case was a
single request from one client.

Sources:
[Considerations for managing body inspection](https://docs.aws.amazon.com/waf/latest/developerguide/web-acl-setting-body-inspection-limit.html) /
[AWS WAF pricing](https://aws.amazon.com/waf/pricing/) /
[Lambda functions as ALB targets](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/lambda-functions.html)

## Inspection boundaries are exact, and `CONTINUE` means "blind past the limit"

A `ByteMatchStatement` on `Body` with `OversizeHandling: CONTINUE` only sees the first N bytes.
A search string whose **last byte** sits at offset N matches. One byte later, it does not:

| Web ACL | String ends at the limit | One byte past |
|---------|-------------------------|---------------|
| ALB (fixed) | 8,192 → 403 | 8,193 → 200 |
| CloudFront `KB_16` (default) | 16,384 → 403 | 16,385 → 200 |
| CloudFront `KB_64` | 65,536 → 403 | 65,537 → 200 |

**Confirmed** in the WAF logs (CloudWatch Logs Insights over `aws-waf-logs-*`):
`requestBodySizeInspectedByWAF` is `8192` on the ALB and `65536` on CloudFront `KB_64` for larger
bodies, and those records carry `oversizeFields: ["REQUEST_BODY"]`. A `SizeConstraintStatement`
with `OversizeHandling: MATCH` is the only thing that sees "the rest" of the body. Its threshold may
be larger than the inspection limit: on CloudFront `KB_64`, `Size: 65536` + `GT` + `MATCH` blocks
exactly the bodies the string rules cannot fully see, and lets 8–64 KB bodies through.

The limit is set on the Web ACL, not the rule:
`AssociationConfig.RequestBody.CLOUDFRONT.DefaultSizeInspectionLimit` (`KB_16|KB_32|KB_48|KB_64`).
Changing it updates the us-east-1 stack in about 15 s and took effect within the next ~20 s.
Only requests whose body exceeds 16 KB pay the extra $0.30 per million per additional 16 KB.

## Behind CloudFront, the ALB Web ACL evaluates the same request again

With CloudFront `KB_64` + oversize threshold 65,536 (BLOCK) and an ALB Web ACL with the blog's
8,192-byte oversize rule in BLOCK, a legitimate 19,771-byte JSON POST through CloudFront came back
**403 `alb:Oversize`**. CloudFront allowed it, and the ALB rule stopped it. Raising CloudFront's
limit does nothing if a stricter regional rule sits behind it. Keep the ALB size rule in COUNT (or
align it) and close direct access to the ALB instead. CloudFront prefix list
`com.amazonaws.global.cloudfront.origin-facing` + a shared-secret header listener rule: a direct
`curl` then times out.

## COUNT-inserted headers reach the origin; BLOCK response headers keep their name

- `count.customRequestHandling.insertHeaders` on the **CloudFront** Web ACL: the header (prefixed
  `x-amzn-waf-`) is forwarded through the ALB to a Lambda target. Verified with an origin that
  echoes `HTTP_X_AMZN_WAF_*`, using the `AllViewer` origin request policy.
- `block.customResponse.responseHeaders`: returned to the client with the configured name as-is
  (no `x-amzn-waf-` prefix).

Naming both after `<layer>:<rule>` makes a two-layer setup debuggable with `curl` alone.

## String matches are case-sensitive with `TextTransformation: NONE`

`Cookie: phpsessid=x` and a body field `php_session_upload_progress=1` both passed the PHP2Shell
rule (`EXACTLY "PHPSESSID"` on cookie keys, `CONTAINS "PHP_SESSION_UPLOAD_PROGRESS"` on the body).
The rule only covers PHP's default `session.name` / `session.upload_progress.name`. Apps that
rename either need the rule strings changed.

## Rate-based rules react late

`RateLimit-Posts` (limit 100 per 60 s, aggregate `IP`, scope-down POST, COUNT) under ~2.4 POST/s
from one IP: the first request carrying the COUNT header was **#138, 57 s after the start**. Do not
expect a rate rule to stop a short burst at the configured number.

## ALB → Lambda 413 happens before the ALB Web ACL

A 1,100,000-byte body sent directly to an ALB with a Lambda target returned **413** and left **no
record in the ALB's WAF log**. 1,048,576 bytes passed (documented 1 MB request limit for Lambda
targets). Through CloudFront, the same body was answered earlier by CloudFront's oversize rule.

## CDK notes

- `ec2.PrefixList.fromLookup({ prefixListName: 'com.amazonaws.global.cloudfront.origin-facing' })`
  writes a `cc-api-provider:...` key to `cdk.context.json`. Unit tests need that key in the `App`
  context to synth offline. The resulting ingress is a separate `AWS::EC2::SecurityGroupIngress`
  (not inline `SecurityGroupIngress`) because the prefix-list ID is a token.
- `wafv2.CfnWebACL.FieldToMatchProperty.singleHeader` is typed `any`. Pass `{ Name: 'content-type' }`
  (CloudFormation casing), not `{ name: ... }`.
- WCU of the blog's four rules: 50 on CloudFront (with an IP-set allow rule), 45 on the ALB without
  the rate rule. For comparison, `AWSManagedRulesCommonRuleSet` alone is 700.
