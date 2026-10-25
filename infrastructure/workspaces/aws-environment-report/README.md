# AWS Environment Report — Monthly Diagram, Cost and Security Report

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-blue?style=flat-square)

> **Draft (deploy-verified except CUR, 2026-10-25).** Deployed to a real account and run end to end with AWS Config, Resource Explorer, Security Hub CSPM, GuardDuty, Inspector, IAM Access Analyzer and Bedrock. CUR has not been read from real data yet. See [Observed results](#-observed-results-2026-10-24) and [Not yet verified](#-not-yet-verified).

## Introduction

A pipeline that builds a monthly report of a single AWS account, stores it in S3 and announces it on Slack / Teams webhooks:

- **Diagram**: a draw.io-editable SVG (the same format as the `aws-icon-diagram` skill) and a PNG
- **Cost overlay**: per-resource cost from CUR 2.0 on every icon, the top 10% / next 20% highlighted, subtotals per VPC and Region
- **Security overlay**: finding counts from Security Hub CSPM, GuardDuty, IAM Access Analyzer and Inspector as badges on the affected resources
- **HTML report**: data source status, Bedrock summary, top costs, findings, coverage (resources Resource Explorer sees but AWS Config does not) and inventory

Compared with letting DevOps Agent investigate the environment, this pattern **collects with deterministic code and only lets the LLM read the aggregated result**, so every month is collected the same way, with the same coverage, and can be compared with the previous one.

![Sample output (synthetic data)](sample-diagram.png)

*Generated from the synthetic data in `src/report-builder/tests/fixtures.py`.*

## 🏗️ Architecture Overview

![Architecture Overview](overview.drawio.svg)

1. **EventBridge Scheduler** starts the state machine every day at 09:00 JST on days 3-10.
2. **Preflight** picks the target month (the previous one) and decides:
   - `reports/YYYY-MM/manifest.json` exists → already built, stop
   - CUR finalized → run
   - not finalized and before `finalizeDeadlineDay` (default 10) → stop, try again tomorrow
   - deadline reached → run with cost marked provisional
3. **Collect (Parallel)**: four collectors write `raw/YYYY-MM/<source>.json`. Each branch catches its own failure and turns it into an `ERROR` status, so one broken source never stops the report.
4. **BuildReport (Python container)**: diagram, HTML and Bedrock summary to `reports/YYYY-MM/` and `reports/latest/`; `manifest.json` is written last because it is the completion marker.
5. **Notify** posts aggregates only to the webhooks stored in Secrets Manager.

Every source reports `OK`, `PARTIAL`, `DISABLED` (service not enabled), `DENIED` (missing IAM permission, kept apart from `DISABLED`) or `ERROR`, per target Region. AWS Config is required for the diagram: if no Region can use it, no diagram is built and the notification says so. Every other source is optional and is only left out of the report when unavailable.

## 🎯 Design Decisions

1. **The LLM does not collect.** An agent calling APIs picks different calls every run, so coverage and month-over-month comparison cannot be guaranteed. Collectors call a fixed set of read APIs; Bedrock only receives aggregated JSON and has no AWS API access.
2. **Placement comes from configuration fields** (`vpcId`, `subnetId`, `subnetIds`, ...) rather than AWS Config relationships, which differ per resource type. One subnet → inside it; several subnets (ALB, Multi-AZ RDS) → the VPC-wide frame; no VPC → Regional services; CloudFront / Route 53 → Global. Public vs private follows the route table (explicit association, else the main table) having an IGW route.
3. **Automatic layout.** Containers measure and stack their children, so nothing can overlap; `find_overlaps` re-checks the result and any overlap becomes a warning. More than four of one type in one container are merged into one "×N" icon.
4. **Unattributable cost is shown, not hidden.** CUR resource IDs are matched against ARNs, resource IDs and ID suffixes; EBS volume cost is added to the attached instance. The report splits the total into cost on drawn resources, cost on resources not drawn, and cost that has no resource (data transfer, support, tax, ...).
5. **The LLM does not rate severity.** Each service's own severity is used; GuardDuty scores follow GuardDuty's ranges, and Access Analyzer (no severity) uses a fixed rule: public = HIGH, other external access = MEDIUM. Only `ProductName = Security Hub` control findings are read from Security Hub, to avoid counting imported GuardDuty / Inspector findings twice.
6. **Publishing will use a separate bucket.** `reports/` is already a static site. An internal ALB + S3 PrivateLink delivery requires the bucket name to equal the host name, and buckets cannot be renamed, so delivery gets its own bucket (`delivery.mode` currently implements `none` only).

## 🔒 Security Considerations

- ✅ Collector IAM is limited to the read APIs they call; a test asserts that every granted collector action is `Describe*` / `Get*` / `List*` / `Select*` / `BatchGet*`, plus `resource-explorer-2:Search` (the action that authorizes `ListResources`)
- ✅ CUR access is read-only and limited to `<prefix>/<exportName>/`
- ✅ Report bucket: SSE-KMS, public access blocked, SSL enforced, versioned; `raw/` expires after `retention.rawDays`
- ✅ Step Functions logs at `ERROR` level without execution data
- ✅ Webhook URLs are treated as credentials and never logged; nothing is sent while the secret holds its default, and non-https entries are skipped
- ✅ Notifications and Bedrock get aggregates only; ARNs and 12-digit account IDs are masked in the Bedrock input
- ✅ Every account-derived value in the HTML and the diagram is escaped
- ⚠️ Individual findings (with resource IDs) are only in `index.html` / `report.json` in S3. Do not publish them through an unauthenticated CloudFront distribution
- ✅ Bedrock `InvokeModel` is limited to the configured inference profile (`summary.bedrockModelId`) in the deploy Region; only the foundation-model ARN keeps a Region wildcard, which cross-region inference requires
- ✅ `test/compliance/cdk-nag.test.ts` passes the AwsSolutions pack. Suppressions and their reasons:
  - `S1` (report bucket access logs): access is limited to this pipeline's roles; object-level auditing belongs to account-wide CloudTrail S3 data events
  - `SMG4` (secret rotation): webhook URLs are issued by Slack / Teams and cannot be rotated by AWS
  - `IAM4`: `AWSLambdaBasicExecutionRole` for the functions' own logs
  - `IAM5`: CDK grant wildcards scoped to the bucket prefixes, the KMS key and the pipeline's own functions; the CUR export prefix; `Resource: *` for read-only collector APIs without resource-level permissions; the foundation-model Region wildcard above
  - `L1`: Node.js 22, the runtime the pattern was deploy-verified with
  - `SF1`: Step Functions logs stay at `ERROR` without execution data so cost figures and finding counts are not copied to CloudWatch Logs

## 💰 Cost

No figures are given here because they depend heavily on Region and account size; use the [AWS Pricing Calculator](https://calculator.aws/#/estimate). The pipeline itself uses Lambda, Step Functions, ECR, S3, KMS, one Secrets Manager secret and one Bedrock call per month. **If AWS Config, Security Hub CSPM, GuardDuty or Inspector are enabled just for this report, they dominate the cost.**

## 📋 Prerequisites

- AWS CLI v2 with a `<project>-<env>` profile, Node.js 20+, AWS CDK 2.x
- **Docker** on the machine running `cdk deploy` (BuildReport is a container image Lambda, built for `linux/amd64`)
- AWS Config recording in the target Regions (`us-east-1` is mandatory for global resource types)
- CUR 2.0 via Data Exports (optional): Parquet, **"overwrite existing report"** (creating a new report per refresh would duplicate files of the same period) and resource IDs included
- Bedrock model access for `summary.bedrockModelId` (optional)

## 🚀 Deployment

1. Edit `parameters/dev-params.ts`: `target.regions` (synth fails without `us-east-1`), `schedule`, `cur` (omit to run without cost data), `security.maxFindingsPerSource`, `summary`. Verify `summary.bedrockModelId` with `aws bedrock list-inference-profiles` ([why](../../../docs/knowledge/aws-service-gotchas.md)).
2. Deploy:

   ```sh
   # in infrastructure/workspaces/aws-environment-report
   npm install
   PROJECT=myproj ENV=dev npm run bootstrap   # once per account/Region
   PROJECT=myproj ENV=dev npm run stage:deploy:all   # cdk deploy '**' (--all does not expand into the Stage)
   ```

3. Edit the secret `<project>-<env>-environment-report-webhooks` by hand. Its default **sends nothing**:

   ```json
   {"webhooks":[{"type":"slack","url":"REPLACE_WITH_WEBHOOK_URL"},{"type":"teams","url":"REPLACE_WITH_WEBHOOK_URL"}]}
   ```

   `type` is `slack` or `teams`; for Teams use a **Workflows** ("When a Teams webhook request is received") URL, since the Office 365 connector Incoming Webhook is being retired. Entries without an https URL are skipped. A hand-edited value survives redeploys; CloudFormation only rewrites it when the template default (`DEFAULT_WEBHOOK_SECRET`) changes.

4. Run manually (rebuilds an existing month; provisional if CUR is not final):

   ```sh
   aws stepfunctions start-execution --state-machine-arn <StateMachineArn> \
     --input '{"targetMonth":"2026-09","force":true}'
   ```

Clean up with `PROJECT=myproj ENV=dev npm run stage:destroy:all`.

## 🧪 Testing

```sh
npm test                                   # CDK + TypeScript Lambdas (Jest): unit, snapshot, cdk-nag
npm run test:snapshot:update               # after an intended template change (asset hashes are masked)
cd src/report-builder                      # report builder (Python; PNG needs libcairo)
python3 -m venv .venv && .venv/bin/pip install cairosvg==2.7.1 pytest
.venv/bin/python -m pytest -q tests
```

## ⚙️ Customization

- Drawn resource types: `CATALOG` in `src/report-builder/app/catalog.py` (undrawn types still appear in the inventory table)
- Static-preview icons: `app/assets/icons.json` holds a real icon for every type in `CATALOG` and the Region / VPC / subnet group badges, taken from this repo's own `overview.drawio.svg` files or the official [AWS Architecture Icons](https://aws.amazon.com/architecture/icons/) package (July 2026 release). A type added to `CATALOG` without an icon shows as a colored square with a short code (draw.io still renders the real `resIcon`); a test fails in that case
- Delivery (not implemented): `internal-alb` / `cloudfront` modes with a separate publish bucket; CloudFront needs WAF and Lambda@Edge (us-east-1) authentication
- Data-flow arrows (not implemented): only containment is drawn today

## 🔬 Observed results (2026-10-24 / 2026-10-25)

Deployments to a single account (`ap-northeast-1`, targets `us-east-1` + `ap-northeast-1`). AWS Config, an ACCOUNT Access Analyzer and, on the second day, Security Hub CSPM (FSBP only), GuardDuty (with sample findings) and Inspector (Lambda + ECR) were enabled only for the test and disabled afterwards; CUR was not configured.

| Item | Result |
|---|---|
| Container image build (`dnf install cairo dejavu-sans-fonts` on `public.ecr.aws/lambda/python:3.12`) | Built and ran; PNG rendered |
| AWS Config (588 items in two Regions) | `OK`; diagram with 19 nodes, 0 overlaps |
| Resource Explorer | `DENIED` on the first run: `ListResources` is authorized by **`resource-explorer-2:Search`**, not `ListResources`. Fixed; `OK` after redeploy, coverage gaps listed |
| Security Hub CSPM not enabled | `DescribeHub` throws `InvalidAccessException` → `DISABLED` (as assumed) |
| GuardDuty / Inspector not enabled | No detector / `BatchGetAccountStatus` = `DISABLED` → `DISABLED` |
| IAM Access Analyzer | `OK`, 12 findings (5 public Lambda = HIGH, 7 external IAM role = MEDIUM); HIGH badge on the Lambda icon |
| CUR not configured | Preflight `NOT_CONFIGURED` → runs immediately. The diagram showed `$0.00/mo` on every container; fixed so cost labels and the cost legend are omitted without CUR data |
| Bedrock (`jp.anthropic.claude-sonnet-4-6`) | `summaryStatus: OK`; the summary called out every non-`OK` source |
| Re-run without `force` / with `{}` | `SKIP` ("report for this month already exists"); `{}` resolved to the previous month in Asia/Tokyo |
| Webhook | Default secret → skipped; `http://` URL → skipped with reason, the URL itself not in CloudWatch Logs |
| Security Hub CSPM (FSBP, about one hour after enabling) | `OK`, 95 FAILED control findings. CSPM control findings still carry `ProductName = "Security Hub"` (`GeneratorId` `security-control/...`), so the filter holds; imported `Config` and custom (`Default`) findings are excluded as intended |
| GuardDuty sample findings | `CreateSampleFindings` made 479 per Region, and the Bedrock summary treated `IAMUser/john_doe` as the top incident. Samples are marked only by `"sample": true` inside `Service.AdditionalInfo.Value` (`ListFindings` cannot filter on it), so the collector now drops them and reports `excluded N sample findings` in the Region message |
| Inspector (136 findings) | Resource IDs are the scanned artifact: `.../repository/<repo>/sha256:<digest>` for an ECR image, `...:function:<name>:$LATEST` for Lambda. They matched no Config resource (107 of 243 findings placed); they are now mapped to the repository / function (243 of 243) |
| Icons | ECR and Internet Gateway showed as colored squares in the HTML/PNG (no static icon bundled). Every `CATALOG` icon is now bundled. Checking all names against draw.io's AWS4 stencils (v24.7.17) found `group_public_subnet` / `group_private_subnet` do not exist; subnets now use `group_security_group` like the rest of this repo |

Known limitation: the PNG uses DejaVu Sans, which has no CJK glyphs, so Japanese resource names render as blanks in `diagram.png` (the draw.io SVG is unaffected). The Amazon Linux 2023 repositories used by the Lambda base image have no CJK font package; bundle a font such as Noto Sans JP in the image if you need it.

## ⚠️ Not yet verified

1. CUR finalization detection via `bill_invoice_id` (blank until final)
2. The CUR path layout `<prefix>/<exportName>/data/BILLING_PERIOD=YYYY-MM/*.parquet`
3. Real (non-sample) GuardDuty findings: only sample findings were available, so their resource mapping is untested
4. The Bedrock model ID in your own account (`jp.anthropic.claude-sonnet-4-6` existed in the test account)

## 📚 References

- [AWS Config advanced queries](https://docs.aws.amazon.com/config/latest/developerguide/querying-AWS-resources.html)
- [AWS Resource Explorer ListResources](https://docs.aws.amazon.com/resource-explorer/latest/apireference/API_ListResources.html)
- [AWS Data Exports (CUR 2.0)](https://docs.aws.amazon.com/cur/latest/userguide/what-is-data-exports.html)
- [GuardDuty severity levels](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_findings-severity.html)
- [Amazon Bedrock Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)
- Related: [security-baseline](../security-baseline/), [aws-eol-monitor](../aws-eol-monitor/)

## 📄 License

See [LICENSE](../../../LICENSE).
