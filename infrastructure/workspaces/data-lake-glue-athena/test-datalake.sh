#!/usr/bin/env bash
# End-to-end check of the data lake: load raw CSV, run the Glue workflow, and verify the curated data with Athena.
# The check needs empty zones, so it refuses to run when they hold data. `--reset` deletes every object in the raw and
# curated zones and drops the two catalog tables first: use it only on this demo stack.
# Usage: ./test-datalake.sh --project <project> --env <env> [--region <region>] [--rows-per-day <n>] [--reset]
set -euo pipefail

PROJECT="" ENVIRONMENT="" REGION="${AWS_REGION:-ap-northeast-1}" ROWS=20000 RESET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --env) ENVIRONMENT="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --rows-per-day) ROWS="$2"; shift 2 ;;
    --reset) RESET=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$PROJECT" && -n "$ENVIRONMENT" ]] || { echo "Usage: $0 --project <project> --env <env> [--region <region>]" >&2; exit 2; }
for cmd in aws jq python3; do command -v "$cmd" >/dev/null || { echo "$cmd is required" >&2; exit 1; }; done

export AWS_PROFILE="${AWS_PROFILE:-${PROJECT}-${ENVIRONMENT}}" AWS_DEFAULT_REGION="$REGION"
STACK="${PROJECT}-${ENVIRONMENT}-data-lake-glue-athena"
DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
FAILED=0
pass() { printf '\033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

RAW="$(out RawBucketName)"; CURATED="$(out CuratedBucketName)"; DB="$(out DatabaseName)"; WF="$(out WorkflowName)"; WG="$(out WorkGroupName)"
echo "stack: $STACK  database: $DB  workflow: $WF"

# athena <sql> -> sets Q_STATE, Q_ROWS (JSON rows, header skipped), Q_SCANNED (bytes), Q_LOCATION
athena() {
  local id; id="$(aws athena start-query-execution --work-group "$WG" --query-execution-context "Database=$DB" --query-string "$1" ${2:+--result-configuration "$2"} --query QueryExecutionId --output text)"
  for _ in $(seq 1 60); do
    Q_STATE="$(aws athena get-query-execution --query-execution-id "$id" --query QueryExecution.Status.State --output text)"
    [[ "$Q_STATE" == SUCCEEDED || "$Q_STATE" == FAILED || "$Q_STATE" == CANCELLED ]] && break; sleep 2
  done
  Q_SCANNED="$(aws athena get-query-execution --query-execution-id "$id" --query QueryExecution.Statistics.DataScannedInBytes --output text)"
  Q_LOCATION="$(aws athena get-query-execution --query-execution-id "$id" --query QueryExecution.ResultConfiguration.OutputLocation --output text)"
  Q_ROWS="$([[ "$Q_STATE" == SUCCEEDED ]] && aws athena get-query-results --query-execution-id "$id" --output json | jq -c '[.ResultSet.Rows[1:][] | [.Data[].VarCharValue]]' || echo '[]')"
}
scalar() { athena "$1"; jq -r '.[0][0]' <<<"$Q_ROWS"; }

run_workflow() { # sets WF_STATUS, WF_STATS and WF_ELAPSED (not run in a subshell: the variables must survive)
  local start=$SECONDS run status
  run="$(aws glue start-workflow-run --name "$WF" --query RunId --output text)"
  for _ in $(seq 1 180); do
    status="$(aws glue get-workflow-run --name "$WF" --run-id "$run" --query Run.Status --output text)"
    [[ "$status" == COMPLETED || "$status" == ERROR || "$status" == STOPPED ]] && break; sleep 10
  done
  WF_STATS="$(aws glue get-workflow-run --name "$WF" --run-id "$run" --query Run.Statistics --output json)"
  WF_STATUS="$status"; WF_ELAPSED=$(( SECONDS - start ))
}

# --- 0. start from empty zones --------------------------------------------------------------------------------------------------
if [[ -n "$(aws s3api list-objects-v2 --bucket "$RAW" --max-items 1 --query 'Contents[0].Key' --output text | grep -v '^None$' || true)" || \
      -n "$(aws s3api list-objects-v2 --bucket "$CURATED" --max-items 1 --query 'Contents[0].Key' --output text | grep -v '^None$' || true)" ]]; then
  [[ "$RESET" == 1 ]] || { echo "the raw or curated zone is not empty; run with --reset to wipe this demo lake first" >&2; exit 1; }
  aws s3 rm "s3://$RAW/" --recursive --only-show-errors; aws s3 rm "s3://$CURATED/" --recursive --only-show-errors
  for t in raw_orders curated_orders; do aws glue delete-table --database-name "$DB" --name "$t" 2>/dev/null || true; done
  echo "zones and tables reset"
fi

# --- 1. load three days of raw CSV (with duplicates, missing ids and negative amounts) ---------------------------------------
EXPECTED="$(python3 "$DIR/sample-data/generate_orders.py" "$WORK" "$ROWS" 4)"
for d in $(jq -r 'keys[0:3][]' <<<"$EXPECTED"); do aws s3 cp "$WORK/orders/dt=$d/orders.csv" "s3://$RAW/orders/dt=$d/orders.csv" --only-show-errors; done
EXP3="$(jq '[to_entries[0:3][].value] | add' <<<"$EXPECTED")"
echo "loaded 3 days; rows that survive cleaning: $EXP3"

# --- 2. run the workflow: crawl raw -> convert -> crawl curated ---------------------------------------------------------------
run_workflow; t="$WF_ELAPSED"
[[ "$WF_STATUS" == COMPLETED && "$(jq .FailedActions <<<"$WF_STATS")" == 0 ]] \
  && pass "workflow completed in ${t}s: $(jq -c '{succeeded:.SucceededActions,failed:.FailedActions}' <<<"$WF_STATS")" \
  || { fail "workflow $WF_STATUS: $WF_STATS"; exit 1; }

# --- 3. the catalog: schema and partitions discovered ---------------------------------------------------------------------------
tbl() { aws glue get-table --database-name "$DB" --name "$1" --output json; }
RAW_T="$(tbl raw_orders)"; CUR_T="$(tbl curated_orders)"
[[ "$(jq -r '.Table.Parameters.classification' <<<"$RAW_T")" == csv && "$(jq '.Table.StorageDescriptor.Columns | map(.Name) | contains(["order_id","amount","order_ts"])' <<<"$RAW_T")" == true ]] \
  && pass "raw_orders: CSV with the header read as column names ($(jq -r '[.Table.StorageDescriptor.Columns[].Name] | join(",")' <<<"$RAW_T"))" || fail "raw_orders schema: $(jq -c '.Table.StorageDescriptor.Columns' <<<"$RAW_T")"
[[ "$(jq -r '.Table.Parameters.classification' <<<"$CUR_T")" == parquet ]] && pass "curated_orders: Parquet, columns $(jq -r '[.Table.StorageDescriptor.Columns[] | "\(.Name):\(.Type)"] | join(" ")' <<<"$CUR_T")" || fail "curated_orders is not Parquet"
partitions() { aws glue get-partitions --database-name "$DB" --table-name "$1" --no-paginate --output json | jq '.Partitions | length'; }
n_raw="$(partitions raw_orders)"; n_cur="$(partitions curated_orders)"
[[ "$n_raw" == 3 && "$n_cur" == 3 ]] && pass "partitions found: 3 raw (dt=...), 3 curated (order_date=...)" || fail "partitions: raw $n_raw, curated $n_cur"

# --- 4. the data: cleaned, de-duplicated, complete ------------------------------------------------------------------------------
RAW_N="$(scalar 'SELECT count(*) FROM raw_orders')"; CUR_N="$(scalar 'SELECT count(*) FROM curated_orders')"
[[ "$CUR_N" == "$EXP3" ]] && pass "curated rows: $CUR_N of $RAW_N raw rows; exactly the $EXP3 valid, unique orders" || fail "curated rows $CUR_N, expected $EXP3 (raw $RAW_N)"
[[ "$(scalar 'SELECT count(*) - count(DISTINCT order_id) FROM curated_orders')" == 0 ]] && pass "curated: no duplicate order ids (raw had $(scalar 'SELECT count(*) - count(DISTINCT order_id) FROM raw_orders'))" || fail "curated still has duplicates"
[[ "$(scalar "SELECT count(*) FROM curated_orders WHERE order_id IS NULL OR order_id = '' OR amount <= 0 OR quantity <= 0")" == 0 ]] && pass "curated: no missing ids and no non-positive amounts" || fail "curated holds invalid rows"

# --- 5. why Parquet and partitions: bytes scanned ---------------------------------------------------------------------------------
# The crawler types the partition key as string, so the filter compares strings.
athena 'SELECT sum(amount) FROM raw_orders'; RAW_SCAN="$Q_SCANNED"; [[ "$Q_STATE" == SUCCEEDED ]] || fail "raw scan query: $Q_STATE"
athena 'SELECT sum(amount) FROM curated_orders'; CUR_SCAN="$Q_SCANNED"; [[ "$Q_STATE" == SUCCEEDED ]] || fail "curated scan query: $Q_STATE"
DAY="$(jq -r 'keys[1]' <<<"$EXPECTED")"
athena "SELECT count(*), sum(amount) FROM curated_orders WHERE order_date = '$DAY'"; DAY_SCAN="$Q_SCANNED"; DAY_ROWS="$(jq -r '.[0][0]' <<<"$Q_ROWS")"
[[ "$CUR_SCAN" -lt "$RAW_SCAN" ]] && pass "same sum(amount): raw CSV scans $RAW_SCAN bytes, curated Parquet $CUR_SCAN ($(( 100 * CUR_SCAN / RAW_SCAN ))%)" || fail "Parquet did not scan less: $RAW_SCAN vs $CUR_SCAN"
[[ "$Q_STATE" == SUCCEEDED && "$DAY_ROWS" == "$(jq -r --arg d "$DAY" '.[$d]' <<<"$EXPECTED")" && "$DAY_SCAN" -lt "$CUR_SCAN" ]] \
  && pass "a filter on the partition column returns that day's $DAY_ROWS rows and scans $DAY_SCAN bytes instead of $CUR_SCAN (partition pruning)" || fail "partition filter: $Q_STATE, $DAY_ROWS rows, $DAY_SCAN vs $CUR_SCAN bytes"

athena "SELECT count(*) FROM curated_orders WHERE order_date = DATE '$DAY'"
[[ "$Q_STATE" == FAILED ]] && pass "comparing the string partition key with a DATE literal fails (TYPE_MISMATCH), as documented" || fail "a DATE comparison was accepted: $Q_STATE"

# --- 6. the workgroup decides where results go ------------------------------------------------------------------------------------
athena 'SELECT 1' "OutputLocation=s3://$RAW/should-be-ignored/"
[[ "$Q_STATE" == SUCCEEDED && "$Q_LOCATION" != *"$RAW"* && "$Q_LOCATION" == s3://* ]] \
  && pass "an attempt to send results to the raw bucket is overridden; they go to $(sed -E 's#(s3://[^/]+/[^/]*/).*#\1#' <<<"$Q_LOCATION")" || fail "result location was not enforced: $Q_LOCATION ($Q_STATE)"
[[ "$(aws s3api head-object --bucket "$(sed -E 's#s3://([^/]+)/.*#\1#' <<<"$Q_LOCATION")" --key "$(sed -E 's#s3://[^/]+/##' <<<"$Q_LOCATION")" --query ServerSideEncryption --output text)" == AES256 ]] \
  && pass "the result object is encrypted (SSE-S3), as the workgroup enforces" || fail "result object is not encrypted"

# --- 7. a new day arrives: rerun, the new partition appears, the old ones are not duplicated --------------------------------------
D4="$(jq -r 'keys[3]' <<<"$EXPECTED")"
aws s3 cp "$WORK/orders/dt=$D4/orders.csv" "s3://$RAW/orders/dt=$D4/orders.csv" --only-show-errors
run_workflow; t="$WF_ELAPSED"
EXP4="$(jq '[.[]] | add' <<<"$EXPECTED")"; CUR_N4="$(scalar 'SELECT count(*) FROM curated_orders')"
n_cur4="$(partitions curated_orders)"
[[ "$WF_STATUS" == COMPLETED && "$CUR_N4" == "$EXP4" && "$n_cur4" == 4 ]] \
  && pass "second run (${t}s) with a new day: 4 curated partitions, $CUR_N4 rows = $EXP3 + the new day; earlier days not duplicated" \
  || fail "second run: status $WF_STATUS, rows $CUR_N4 (expected $EXP4), partitions $n_cur4"

exit "$FAILED"
