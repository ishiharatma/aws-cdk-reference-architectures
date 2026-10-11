# Data Lake with AWS Glue and Amazon Athena - AWS CDK Reference Architecture

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

The basic shape of an AWS data lake and the ETL that feeds it: a **raw zone** of CSV, a **Glue workflow** (crawler, Spark job, crawler) that catalogs the data and converts it into **cleaned, de-duplicated, typed, partitioned Parquet**, a **curated zone**, and **Amazon Athena** on top with a workgroup that caps the data a query may scan and enforces encrypted results. The focus is automating the ETL (as opposed to [`waf-log-reporting`](../waf-log-reporting/), which queries logs in place with partition projection), and showing with numbers what Parquet and partitions buy you.

## 📑 Table of Contents

- [Architecture Overview](#️-architecture-overview)
- [Design Decisions & Best Practices](#-design-decisions--best-practices)
- [Well-Architected Alignment](#️-well-architected-alignment)
- [Cost Optimization](#-cost-optimization)
- [Security Considerations](#-security-considerations)
- [Prerequisites](#-prerequisites)
- [Deployment Guide](#-deployment-guide)
- [Operational Check Script](#-operational-check-script)
- [Testing Strategy](#-testing-strategy)
- [Customization](#️-customization)
- [Troubleshooting](#-troubleshooting)
- [Clean-up](#-clean-up)
- [References](#-references)

## 🏗️ Architecture Overview

![Architecture Diagram](overview.drawio.svg)

### Key Components

- **Three buckets** — raw (CSV, `orders/dt=YYYY-MM-DD/`), curated (Parquet, `orders/order_date=YYYY-MM-DD/`) and Athena results. All private, TLS-only and encrypted; only the results bucket expires objects.
- **Glue database and two crawlers** — one over each zone, with table prefixes `raw_` and `curated_`. They update the table in place, only log removed objects, and let partitions inherit the table schema.
- **Glue ETL job** (`glue-jobs/orders_to_parquet.py`, Spark, Glue 5.0, 2 × G.1X) — reads `raw_orders` from the catalog, types the columns, drops rows with no order id, no timestamp or a non-positive quantity or amount, keeps one row per order id (the latest timestamp wins), derives `order_date` and writes Parquet partitioned by it.
- **Glue workflow** — `crawl raw` → `convert` → `crawl curated`, each step a conditional trigger on the previous one succeeding. Started on demand, or on a cron schedule if you set one.
- **Athena workgroup** — enforced result location with SSE-S3, a bytes-scanned cutoff per query, CloudWatch metrics, and one named query.
- **`test-datalake.sh`** and **`sample-data/generate_orders.py`** — generate three days of orders with duplicates, missing ids and negative amounts, run the workflow and verify the result.

## 🎯 Design Decisions & Best Practices

### 1. Raw and curated are different zones, with different permissions

The Glue role may only read the raw bucket and may read and write the curated bucket. The raw zone is the record of what arrived: nothing in the pipeline can alter it, and the curated zone can always be rebuilt from it. A test asserts that the role has no write permission on the raw bucket.

### 2. Convert to Parquet and partition: measured, not claimed

For the same `SELECT sum(amount)` over three days of orders:

| Source | Data scanned |
|---|---|
| Raw CSV | 3,673,905 bytes |
| Curated Parquet | 267,615 bytes (7%) |
| Curated Parquet, one day (`order_date = '2026-10-02'`) | 89,157 bytes |

Parquet is columnar, so only `amount` is read; the partition filter reads one folder instead of three. Athena bills by data scanned, so this is also the cost ratio. The dataset is tiny; the ratio is what carries over.

### 3. The ETL cleans, and the check proves it

The generated raw data holds 60,600 rows for three days, of which 747 are duplicated exports, plus rows with a missing order id and rows with a negative amount. The curated table holds exactly the 59,770 valid, unique orders, has no duplicate order id, no empty id and no non-positive amount. A "clean" job that nobody verified is a liability.

### 4. Re-running is safe: dynamic partition overwrite

The job sets `spark.sql.sources.partitionOverwriteMode=dynamic` and writes with `overwrite`, so it replaces only the partitions present in its input. Adding a fourth day and re-running the workflow produced 4 partitions and 79,692 rows (59,770 plus the new day), with the earlier days not duplicated. Without dynamic mode, `overwrite` would delete every partition of the target.

### 5. The crawler types partition keys as `string`

`order_date` becomes a `string` partition key, so `WHERE order_date = DATE '2026-10-02'` fails with `TYPE_MISMATCH: Cannot apply operator: varchar = date`. Compare with a string (`'2026-10-02'`). A failed query reports 0 bytes scanned, so check the query state before drawing conclusions from the statistics. The named query and the check script use strings; the script also asserts that the `DATE` form fails.

### 6. A workflow instead of three schedules

Three independently scheduled pieces would race: the job could run before the crawler finished. Conditional triggers start each step only after the previous one succeeded, and one workflow run is one unit you can start, watch and rerun. A run took about 4.5 minutes for two crawlers and a 2-worker job.

### 7. The workgroup enforces what analysts cannot be trusted to remember

With `enforceWorkGroupConfiguration`, a query started with its own `OutputLocation` in another bucket is still written to the workgroup's location, encrypted. The `bytesScannedCutoffPerQuery` cancels a query that would scan more than the limit (100 MB here; the minimum is 10 MB). The scan limit was not triggered by this dataset and is therefore not exercised by the check script.

### 8. Crawler runs cost the most, so the schedule is optional

Each crawler run is billed with a 10-minute minimum, which is more than the Spark job costs. `workflowSchedule` is therefore unset by default: run on demand, or schedule only as often as data actually arrives. For data with a known layout, adding partitions yourself (`ALTER TABLE ADD PARTITION`, or partition projection as in `waf-log-reporting`) avoids the crawler.

### 9. What this does not do

Fine-grained access control (Lake Formation column and row permissions), schema evolution policy, data quality rules beyond the filters in the job, and a streaming path. Lake Formation is the natural next step.

### 10. Environment-specific parameters

`parameters/<env>-params.ts` sets the Glue version, worker type and count, an optional workflow schedule, the Athena scan cutoff and the retention of results and logs.

## 🏛️ Well-Architected Alignment

| Pillar | How this architecture addresses it |
|---|---|
| Operational Excellence | One workflow run is the unit of operation; `test-datalake.sh` verifies the data, not just the deployment; CloudFormation-managed |
| Security | Private TLS-only encrypted buckets, a Glue role that cannot write the raw zone, enforced encrypted Athena results, no public access |
| Reliability | Conditional workflow steps, no job retries that would hide a bad input, an idempotent rerun, a raw zone that can rebuild the curated one |
| Performance Efficiency | Columnar Parquet and partitions: 7% of the bytes scanned for the same query |
| Cost Optimization | Scan limit per query, results that expire, an optional schedule, and the measured scan reduction |
| Sustainability | Less data scanned and stored per question; pay-per-use services with nothing running between workflow runs |

## 💰 Cost Optimization

Approximate costs in `ap-northeast-1` (verify against the pricing pages):

| Item | Approx. |
|---|---|
| Glue crawlers | per DPU-hour with a 10-minute minimum per run: a few cents per run, two runs per workflow |
| Glue Spark job | per DPU-hour with a 1-minute minimum: 2 workers for a few minutes, a few cents |
| Athena | per TB scanned; the sample queries scan kilobytes to megabytes |
| S3 | storage and requests for a few megabytes; results expire |

By the unit prices above, one run of the check script (two workflow runs and a dozen queries) costs a few tens of cents. Nothing runs between workflow runs, so a lake that is left deployed costs only S3 storage unless you schedule the workflow.

## 🔒 Security Considerations

### Implemented

- All buckets: block public access, SSE-S3, TLS-only. Athena results expire.
- The Glue role reads the raw zone, writes only the curated zone, and has the AWS-managed `AWSGlueServiceRole` for Glue and logs.
- The Athena workgroup enforces its configuration (location and encryption) and the per-query scan cutoff.
- The job logs hold counts, not data values.

### CDK Nag suppressions (with reasons)

| Rule | Reason |
|---|---|
| AwsSolutions-S1 | The zone buckets hold a reference dataset; server access logs would need another bucket |
| AwsSolutions-IAM4 / IAM5 | `AWSGlueServiceRole` is the documented managed policy; the role reads and writes objects of the zone buckets (`bucket/*`) |
| AwsSolutions-L1 | The auto-delete provider runtime is managed by CDK |
| AwsSolutions-GL1 | No Glue security configuration; objects use the S3 default encryption and logs hold no data values |
| AwsSolutions-GL3 | Job bookmarks are not used; the job rewrites the partitions of its input, which is idempotent |
| AwsSolutions-ATH1 | Results are SSE-S3 encrypted and enforced; SSE-KMS would add a key every analyst needs |

### Out of scope (add per environment)

Lake Formation permissions, a customer managed KMS key for the zones, a Glue security configuration, VPC endpoints for a private deployment, and monitoring of failed workflow runs.

## 📋 Prerequisites

- Node.js 24+, AWS CDK v2, an AWS account with CDK bootstrapped
- The account's Lake Formation settings must allow IAM-only access (the default `IAM_ALLOWED_PRINCIPALS`); otherwise grant the Glue role and the analysts Lake Formation permissions
- `aws`, `jq` and `python3` for `test-datalake.sh`

## 🚀 Deployment Guide

```bash
export PROJECT=<project> ENV=dev
npm install
npm run stage:deploy:all -w workspaces/data-lake-glue-athena   # about 1 minute
./workspaces/data-lake-glue-athena/test-datalake.sh --project $PROJECT --env $ENV   # about 10 minutes
```

To run the workflow yourself: put CSV files under `s3://<raw-bucket>/orders/dt=YYYY-MM-DD/`, then `aws glue start-workflow-run --name <project>-<env>-lake-workflow`.

## 🧪 Operational Check Script

`./test-datalake.sh --project <project> --env <env>` (add `--reset` to wipe a lake that already holds data; use it on this demo stack only):

1. generates three days of orders and uploads them
2. runs the workflow and expects it to complete with no failed action
3. checks the catalog: `raw_orders` is CSV with the header read as column names, `curated_orders` is Parquet with typed columns, 3 raw and 3 curated partitions
4. checks the data: 59,770 curated rows from 60,600 raw rows, no duplicate order ids, no empty ids, no non-positive amounts
5. compares bytes scanned (CSV, Parquet, one partition) and checks the partition-pruned result against the expected rows of that day
6. checks that a `DATE` literal against the string partition key fails
7. checks that a query that asks for another result location is overridden and the result is encrypted
8. adds a fourth day, reruns the workflow and checks 4 partitions and 79,692 rows, with the earlier days not duplicated

Verified on 2026-10-10 in `ap-northeast-1`: all checks passed; a workflow run took 270 s and 279 s.

## 🧪 Testing Strategy

```bash
npm test -w workspaces/data-lake-glue-athena
```

- **Snapshot**: the full template and resource counts.
- **Unit**: the three private buckets and where objects expire, the database, the crawlers and their policies, the job's version, capacity and arguments, the Glue role's write scope, the three-step workflow and the optional schedule, the Athena workgroup, the string-typed named query, and the production retention of buckets.
- **Compliance**: CDK Nag `AwsSolutionsChecks` with the reasons above.

## ⚙️ Customization

| Parameter | Meaning |
|---|---|
| `glueVersion`, `glueWorkerType`, `glueNumberOfWorkers` | Capacity of the ETL job |
| `workflowSchedule` | A cron expression to run the workflow on a schedule; unset for on-demand runs |
| `athenaBytesScannedCutoff` | Largest scan one query may do (10 MB or more) |
| `athenaResultsExpirationDays`, `logRetentionDays` | Retention |

For your own data, change the script (`glue-jobs/orders_to_parquet.py`) and the crawler targets; the workflow and the workgroup stay as they are.

## 🔧 Troubleshooting

### `TYPE_MISMATCH: Cannot apply operator: varchar = date`

The partition key is a `string`. Compare with `'2026-10-02'`, or cast: `CAST(order_date AS date)` (which prevents partition pruning).

### The workflow completes but the curated table has no new partition

The curated crawler runs only after the job succeeded. Check the job run's logs (`/aws-glue/jobs/`) and the crawler run; a crawler that finds no new folders adds no partition.

### A rerun duplicated rows

The job must write with `partitionOverwriteMode=dynamic`. Without it, `overwrite` replaces the whole target, or an `append` adds the same rows again.

### Athena returns 0 bytes scanned

The query probably failed. Look at the query state and its reason, not only at the statistics.

### Glue cannot create the database

The account's Lake Formation settings require explicit permissions. Grant the deploying role and the Glue role Lake Formation permissions, or use the default IAM-only access.

## 🧹 Clean-up

```bash
npm run stage:destroy:all -w workspaces/data-lake-glue-athena
```

The buckets are emptied automatically in development.

## 📚 References

- [AWS Glue workflows](https://docs.aws.amazon.com/glue/latest/dg/workflows_overview.html)
- [Using crawlers to populate the Data Catalog](https://docs.aws.amazon.com/glue/latest/dg/add-crawler.html)
- [Top 10 performance tuning tips for Amazon Athena](https://aws.amazon.com/blogs/big-data/top-10-performance-tuning-tips-for-amazon-athena/)
- [Using workgroups to control query access and costs](https://docs.aws.amazon.com/athena/latest/ug/manage-queries-control-costs-with-workgroups.html)
