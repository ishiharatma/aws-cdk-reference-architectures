# AWS Environment Report — Monthly Diagram, Cost and Security Report

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-blue?style=flat-square)

> **Draft (not deploy-verified).** Unit tests on synthetic data, `cdk synth` and a visual check of the rendered PNG are done. It has not been deployed to an AWS account or run against real data yet. See [Not yet verified](#-not-yet-verified).

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

- ✅ Collector IAM is limited to the read APIs they call; a test asserts that every granted collector action is `Describe*` / `Get*` / `List*` / `Select*` / `BatchGet*`
- ✅ CUR access is read-only and limited to `<prefix>/<exportName>/`
- ✅ Report bucket: SSE-KMS, public access blocked, SSL enforced, versioned; `raw/` expires after `retention.rawDays`
- ✅ Step Functions logs at `ERROR` level without execution data
- ✅ Webhook URLs are treated as credentials and never logged; nothing is sent while the secret holds its default, and non-https entries are skipped
- ✅ Notifications and Bedrock get aggregates only; ARNs and 12-digit account IDs are masked in the Bedrock input
- ✅ Every account-derived value in the HTML and the diagram is escaped
- ⚠️ Individual findings (with resource IDs) are only in `index.html` / `report.json` in S3. Do not publish them through an unauthenticated CloudFront distribution
- ⚠️ No `test/compliance` (cdk-nag) suite yet

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
   PROJECT=myproj ENV=dev npm run deploy:all
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

Clean up with `PROJECT=myproj ENV=dev npm run destroy:all`.

## 🧪 Testing

```sh
npm test                                   # CDK + TypeScript Lambdas (Jest)
cd src/report-builder                      # report builder (Python; PNG needs libcairo)
python3 -m venv .venv && .venv/bin/pip install cairosvg==2.7.1 pytest
.venv/bin/python -m pytest -q tests
```

## ⚙️ Customization

- Drawn resource types: `CATALOG` in `src/report-builder/app/catalog.py` (undrawn types still appear in the inventory table)
- Static-preview icons: `app/assets/icons.json` holds real icons extracted from this repo's own `overview.drawio.svg` files; other services show as a colored square with a short code (draw.io renders the real `resIcon`)
- Delivery (not implemented): `internal-alb` / `cloudfront` modes with a separate publish bucket; CloudFront needs WAF and Lambda@Edge (us-east-1) authentication
- Data-flow arrows (not implemented): only containment is drawn today

## ⚠️ Not yet verified

1. The container image build (`dnf install cairo dejavu-sans-fonts`); a PNG failure only drops the PNG, SVG and HTML are still written
2. The exception names used for "not enabled" (e.g. `InvalidAccessException` for Security Hub); unexpected names show up as `ERROR`
3. CUR finalization detection via `bill_invoice_id` (blank until final)
4. The CUR path layout `<prefix>/<exportName>/data/BILLING_PERIOD=YYYY-MM/*.parquet`
5. draw.io icon names not used elsewhere in this repo (`rds`, `aurora`, `elasticache`, `eks`, `ecr`, `elastic_file_system`, `route_53`, `kinesis_data_streams`, `auto_scaling2`) and the subnet group icons (`group_public_subnet` / `group_private_subnet`)
6. The Bedrock model ID `jp.anthropic.claude-sonnet-4-6` in your account

## 📚 References

- [AWS Config advanced queries](https://docs.aws.amazon.com/config/latest/developerguide/querying-AWS-resources.html)
- [AWS Resource Explorer ListResources](https://docs.aws.amazon.com/resource-explorer/latest/apireference/API_ListResources.html)
- [AWS Data Exports (CUR 2.0)](https://docs.aws.amazon.com/cur/latest/userguide/what-is-data-exports.html)
- [GuardDuty severity levels](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_findings-severity.html)
- [Amazon Bedrock Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)
- Related: [security-baseline](../security-baseline/), [aws-eol-monitor](../aws-eol-monitor/)

## 📄 License

See [LICENSE](../../../LICENSE).
