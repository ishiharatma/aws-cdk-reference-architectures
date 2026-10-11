# Glue + Athena Data Lake — Gotchas Worth Knowing

Verified while deploy-verifying `data-lake-glue-athena` (ap-northeast-1, aws-cdk-lib 2.270, Glue 5.0, October 2026).

## The crawler types a partition key as `string`, so a `DATE` literal fails

A crawler over `order_date=2026-10-02/` folders creates the partition key `order_date` as `string`.
`WHERE order_date = DATE '2026-10-02'` fails with `TYPE_MISMATCH: Cannot apply operator: varchar = date`
(`>=` fails the same way). Compare with a string: `WHERE order_date = '2026-10-02'`. A failed Athena query reports
`DataScannedInBytes: 0`; check `Status.State` before concluding that a filter "scanned nothing".

## A Glue workflow is crawler → job → crawler with conditional triggers

`CfnWorkflow` plus three `CfnTrigger`s: an `ON_DEMAND` (or `SCHEDULED`) start trigger for the raw crawler, a
`CONDITIONAL` trigger on the crawler's `crawlState: SUCCEEDED` that starts the job, and a `CONDITIONAL` trigger on the
job's `state: SUCCEEDED` that starts the curated crawler. Conditional triggers need `startOnCreation: true`, and every
trigger must depend on the crawlers and the job it names. `aws glue start-workflow-run` starts it; poll
`get-workflow-run` until `COMPLETED` (about 4.5 minutes for two crawlers and a 2-worker Glue 5.0 job).

## Dynamic partition overwrite makes a rerun idempotent

`spark.conf.set("spark.sql.sources.partitionOverwriteMode", "dynamic")` with `mode("overwrite")` replaces only the
partitions present in the input. Rerunning the workflow with the same files kept the row count; adding a new `dt=` folder added exactly one new
`order_date` partition and its rows.

## `aws glue get-partitions` is paginated; `--query length(...)` prints one number per page

With the default pagination `--query 'length(Partitions)' --output text` printed `3` and then `0`. Use
`--no-paginate` and count with `jq '.Partitions | length'`.

## A crawler's header detection needs no custom classifier here

A CSV with a header row and typed-looking columns was read with the header as column names
(`order_id,customer_id,product,quantity,amount,order_ts`); the timestamp stayed `string` and was cast in the job.

## The Athena workgroup, not the client, decides the result location

With `enforceWorkGroupConfiguration: true`, a query started with its own `OutputLocation` in another bucket still wrote to the
workgroup's location, and the result object was SSE-S3 encrypted.

## Cost shape

Each crawler run is billed with a 10-minute minimum; the Spark job with a 1-minute minimum per run. A schedule that is
not needed is the main avoidable cost, so the schedule is an optional parameter. Parquet scanned 7% of the bytes of the
same CSV for `sum(amount)`.
