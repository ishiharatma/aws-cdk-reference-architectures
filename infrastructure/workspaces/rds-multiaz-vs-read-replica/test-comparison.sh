#!/usr/bin/env bash
# Shows the difference between a Multi-AZ standby and a read replica on the deployed stack, then promotes the replica.
# Usage: ./test-comparison.sh --project <project> --env <env> [--region <region>] [--no-promote]
# The promotion cannot be undone (the replica becomes a standalone instance); destroy the stack afterwards.
set -euo pipefail

PROJECT="" ENVIRONMENT="" REGION="${AWS_REGION:-ap-northeast-1}" PROMOTE=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --env) ENVIRONMENT="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --no-promote) PROMOTE=0; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$PROJECT" && -n "$ENVIRONMENT" ]] || { echo "Usage: $0 --project <project> --env <env> [--region <region>] [--no-promote]" >&2; exit 2; }
for cmd in aws jq; do command -v "$cmd" >/dev/null || { echo "$cmd is required" >&2; exit 1; }; done

export AWS_PROFILE="${AWS_PROFILE:-${PROJECT}-${ENVIRONMENT}}" AWS_DEFAULT_REGION="$REGION"
STACK="${PROJECT}-${ENVIRONMENT}-rds-multiaz-vs-read-replica"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
FAILED=0
pass() { printf '\033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

FN="$(out ProbeFunctionName)"; PRIMARY="$(out PrimaryIdentifier)"; REPLICA="$(out ReplicaIdentifier)"
probe() { # $1 = JSON event -> JSON result on stdout
  aws lambda invoke --function-name "$FN" --cli-binary-format raw-in-base64-out --cli-read-timeout 0 --payload "$1" "$WORK/out.json" >/dev/null
  jq -c . "$WORK/out.json"
}
db() { aws rds describe-db-instances --db-instance-identifier "$1" --query 'DBInstances[0]' --output json; }
echo "stack: $STACK  primary: $PRIMARY  replica: $REPLICA"

# --- 1. what AWS says each one is -------------------------------------------------------------------------------------------------
P="$(db "$PRIMARY")"; R="$(db "$REPLICA")"
[[ "$(jq .MultiAZ <<<"$P")" == true && -n "$(jq -r .SecondaryAvailabilityZone <<<"$P")" && "$(jq -r .SecondaryAvailabilityZone <<<"$P")" != null ]] \
  && pass "primary: Multi-AZ, running in $(jq -r .AvailabilityZone <<<"$P") with a standby in $(jq -r .SecondaryAvailabilityZone <<<"$P")" || fail "primary is not a Multi-AZ instance"
[[ "$(jq -r .ReadReplicaSourceDBInstanceIdentifier <<<"$R")" == "$PRIMARY" && "$(jq .MultiAZ <<<"$R")" == false ]] \
  && pass "replica: a read replica of the primary, single-AZ, running in $(jq -r .AvailabilityZone <<<"$R")" || fail "replica is not a single-AZ read replica of the primary"

# --- 2. what the databases say ------------------------------------------------------------------------------------------------------
INFO="$(probe '{"action":"info"}')"
[[ "$(jq .primary.inRecovery <<<"$INFO")" == false && "$(jq .replica.inRecovery <<<"$INFO")" == true ]] \
  && pass "pg_is_in_recovery(): primary false, replica true (the replica is a standby that serves reads); $(jq -r .primary.version <<<"$INFO")" || fail "recovery state: $INFO"
echo "note: the Multi-AZ standby has no endpoint at all, so nothing can be read from it; only the replica can"

# --- 3. writes ----------------------------------------------------------------------------------------------------------------------
W="$(probe '{"action":"write"}')"
[[ "$(jq .primary.accepted <<<"$W")" == true && "$(jq .replica.accepted <<<"$W")" == false && "$(jq -r .replica.message <<<"$W")" == *"read-only transaction"* ]] \
  && pass "writes: the primary accepts, the replica refuses ($(jq -r .replica.message <<<"$W"))" || fail "write behaviour: $W"

# --- 4. replication lag -------------------------------------------------------------------------------------------------------------
L="$(probe '{"action":"lag","samples":30}')"
[[ "$(jq .visible <<<"$L")" == 30 && "$(jq .maxMs <<<"$L")" -lt 5000 ]] \
  && pass "asynchronous replication: 30 of 30 writes visible on the replica, median $(jq .medianMs <<<"$L") ms, p95 $(jq .p95Ms <<<"$L") ms, max $(jq .maxMs <<<"$L") ms" || fail "lag: $L"
# ReplicaLag is time since the last replayed transaction, so it needs writes, and the stack's heartbeat writes once a minute:
# the metric then sits between 0 and about 60 s even though the markers above became visible in milliseconds.
# Without any heartbeat an idle primary makes it climb by 60 s every minute. Wait for a few datapoints taken with the heartbeat.
for _ in $(seq 1 16); do
  LAGS="$(aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name ReplicaLag --dimensions Name=DBInstanceIdentifier,Value="$REPLICA" \
    --start-time "$(date -u -d '-6 minutes' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" --period 60 --statistics Maximum --query 'sort_by(Datapoints,&Timestamp)[].Maximum' --output json)"
  [[ "$(jq length <<<"$LAGS")" -ge 4 && "$(jq 'max' <<<"$LAGS")" -lt 90 ]] && break; sleep 30
done
[[ "$(jq length <<<"$LAGS")" -ge 4 && "$(jq 'max' <<<"$LAGS")" -lt 90 ]] \
  && pass "CloudWatch ReplicaLag with the 1-minute heartbeat: $(jq -c . <<<"$LAGS") s, bounded by the heartbeat interval, not growing (the marker lag above was milliseconds)" || fail "ReplicaLag is not bounded: $LAGS"
[[ "$(aws cloudwatch describe-alarms --alarm-names "${PROJECT}-${ENVIRONMENT}-rdscmp-replica-lag" --query 'MetricAlarms[0].StateValue' --output text)" != ALARM ]] \
  && pass "the ReplicaLag alarm is not in ALARM" || fail "the ReplicaLag alarm is in ALARM"

# --- 5. a Multi-AZ failover of the primary, seen from both endpoints ---------------------------------------------------------------
AZ_BEFORE="$(jq -r .AvailabilityZone <<<"$(db "$PRIMARY")")"
probe '{"action":"watch","durationSeconds":330,"intervalMs":1000}' > "$WORK/watch.json" &
WATCH_PID=$!
sleep 25
aws rds reboot-db-instance --db-instance-identifier "$PRIMARY" --force-failover >/dev/null
wait "$WATCH_PID"
W="$(cat "$WORK/watch.json")"
P_OUT="$(jq -c '.targets[] | select(.target=="primary") | .outages' <<<"$W")"; R_OUT="$(jq -c '.targets[] | select(.target=="replica") | .outages' <<<"$W")"
AZ_AFTER="$(jq -r .AvailabilityZone <<<"$(db "$PRIMARY")")"
P_SEC="$(jq '[.[] | .seconds] | add // 0' <<<"$P_OUT")"; R_SEC="$(jq '[.[] | .seconds] | add // 0' <<<"$R_OUT")"
[[ "$(jq length <<<"$P_OUT")" -ge 1 && "$(jq '[.[] | select(.seconds == null)] | length' <<<"$P_OUT")" == 0 ]] \
  && pass "failover: the primary endpoint was unreachable for $P_SEC s in total ($(jq length <<<"$P_OUT") window) and came back" || fail "primary outage windows: $P_OUT"
[[ "$AZ_BEFORE" != "$AZ_AFTER" ]] && pass "failover: the primary moved from $AZ_BEFORE to $AZ_AFTER (the standby took over)" || fail "primary stayed in $AZ_BEFORE"
echo "note: replica endpoint during the failover: $(jq -c '.targets[] | select(.target=="replica") | {ok,failed}' <<<"$W"), unreachable $R_SEC s in total ($(jq length <<<"$R_OUT") window)"
L="$(probe '{"action":"lag","samples":20}')"
[[ "$(jq .visible <<<"$L")" == 20 ]] && pass "after the failover the replica follows the new primary again: 20 of 20 writes visible (median $(jq .medianMs <<<"$L") ms)" || fail "replication did not resume: $L"

# --- 6. promoting the replica: a one-way door ----------------------------------------------------------------------------------------
if [[ "$PROMOTE" == 1 ]]; then
  aws rds promote-read-replica --db-instance-identifier "$REPLICA" >/dev/null
  sleep 60
  aws rds wait db-instance-available --db-instance-identifier "$REPLICA"
  R="$(db "$REPLICA")"
  [[ "$(jq -r .ReadReplicaSourceDBInstanceIdentifier <<<"$R")" == null ]] && pass "promotion: the instance is no longer a replica of anything" || fail "still a replica: $(jq -r .ReadReplicaSourceDBInstanceIdentifier <<<"$R")"
  INFO="$(probe '{"action":"info"}')"; W="$(probe '{"action":"write"}')"
  [[ "$(jq .replica.inRecovery <<<"$INFO")" == false && "$(jq .replica.accepted <<<"$W")" == true ]] \
    && pass "promotion: the former replica is writable now (pg_is_in_recovery false, INSERT accepted)" || fail "promoted instance: $INFO $W"
  D="$(probe '{"action":"diverge","samples":15}')"
  [[ "$(jq .visibleOnOtherEndpoint <<<"$D")" == false ]] \
    && pass "promotion: a write to the primary $(jq .waitedSeconds <<<"$D") s ago does not reach the promoted instance; the two are independent databases now" || fail "the promoted instance still received the primary's write: $D"
fi

exit "$FAILED"
