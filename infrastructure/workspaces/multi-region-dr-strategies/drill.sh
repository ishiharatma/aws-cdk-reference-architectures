#!/usr/bin/env bash
# DR drill: measures RPO and RTO of the four strategies against the deployed stacks.
# Usage: ./drill.sh --project <project> --env <env> [--only rpo|warm-standby|active-active|pilot-light|backup-restore|cleanup]
#   cleanup deletes the recovery points in both vaults; run it before destroying the stacks (a vault with recovery points cannot be deleted).
# Needs: aws, jq, curl. The pilot-light drill also runs `cdk deploy` of the recovery stack from this directory.
set -euo pipefail

PROJECT="" ENVIRONMENT="" ONLY="all" PRIMARY="ap-northeast-1" DR="ap-northeast-3" TIMEOUT=300
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --env) ENVIRONMENT="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --primary-region) PRIMARY="$2"; shift 2 ;;
    --dr-region) DR="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$PROJECT" && -n "$ENVIRONMENT" ]] || { echo "Usage: $0 --project <project> --env <env> [--only <drill>]" >&2; exit 2; }
for cmd in aws jq curl; do command -v "$cmd" >/dev/null || { echo "$cmd is required" >&2; exit 1; }; done

export AWS_PROFILE="${AWS_PROFILE:-${PROJECT}-${ENVIRONMENT}}"
PREFIX="${PROJECT}-${ENVIRONMENT}-dr"
FAILED=0
declare -a RESULTS=()

pass() { printf '\033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
note() { RESULTS+=("$1"); }
now() { date +%s.%N; }
elapsed() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }'; }

pout() { aws cloudformation describe-stacks --stack-name "${PROJECT}-${ENVIRONMENT}-dr-primary" --region "$PRIMARY" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
dout() { aws cloudformation describe-stacks --stack-name "${PROJECT}-${ENVIRONMENT}-dr-secondary" --region "$DR" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
host_of() { sed -E 's#https://([^/]+)/?#\1#' <<<"$1"; }
table() { echo "${PREFIX}-$1-orders"; }

RESOLVER="$(pout ResolverFunctionName)"
RESPONSE_FILE="$(mktemp)"
resolve() { # $1 = record name; prints the CNAME target (without trailing dot)
  aws lambda invoke --function-name "$RESOLVER" --region "$PRIMARY" --cli-binary-format raw-in-base64-out \
    --payload "{\"name\":\"$1\"}" "$RESPONSE_FILE" >/dev/null 2>&1 && jq -r '.cname[0] // "unresolved"' "$RESPONSE_FILE" | sed 's/\.$//' || echo unresolved
}
set_fail() { # $1 = strategy short name, $2 = true|false  (primary-region function)
  local fn="${PREFIX}-$1-primary"
  local table_name; table_name="$(table "$1")"
  aws lambda update-function-configuration --function-name "$fn" --region "$PRIMARY" \
    --environment "Variables={STRATEGY=$1,TABLE_NAME=$table_name,FAIL=$2}" >/dev/null
  aws lambda wait function-updated --function-name "$fn" --region "$PRIMARY"
}
wait_resolve() { # $1 = record, $2 = expected host
  local start; start="$(now)"
  while (( $(awk -v s="$start" -v n="$(now)" 'BEGIN{print (n-s) < '"$TIMEOUT"'}') )); do
    [[ "$(resolve "$1")" == "$2" ]] && { elapsed "$start"; return 0; }
    sleep 2
  done
  return 1
}
cleanup() { rm -f "$RESPONSE_FILE"; for s in ws aa; do set_fail "$s" false >/dev/null 2>&1 || true; done
  aws lambda put-function-concurrency --function-name "${PREFIX}-ws" --reserved-concurrent-executions 0 --region "$DR" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PRIMARY_URL_PL="$(pout PLUrl)"; PRIMARY_URL_WS="$(pout WSUrl)"; PRIMARY_URL_AA="$(pout AAUrl)"
WS_HOST_PRIMARY="$(host_of "$PRIMARY_URL_WS")"; WS_STANDBY_URL="$(dout WarmStandbyUrl)"; WS_HOST_DR="$(host_of "$WS_STANDBY_URL")"
AA_HOST_PRIMARY="$(host_of "$PRIMARY_URL_AA")"; AA_HOST_DR="$(host_of "$(dout ActiveActiveUrl)")"

post_order() { curl -s -m 10 -X POST -H 'content-type: application/json' -d "{\"id\":\"$2\"}" "${1%/}/orders" | jq -r .id; }

# --------------------------------------------------------------------------------------------------
# RPO: how long until a write in the primary region is readable in the DR region (global tables)
# --------------------------------------------------------------------------------------------------
drill_rpo() {
  echo "== RPO (global table replication lag)"
  for s in pl ws aa; do
    local url_var="PRIMARY_URL_${s^^}"
    curl -s -m 10 "${!url_var}" >/dev/null   # warm up the function so the Lambda cold start is not counted
    local i
    for i in 1 2 3; do
      local id="rpo-$s-$i-$(date +%s)" start
      post_order "${!url_var}" "$id" >/dev/null
      start="$(now)"   # the write has been acknowledged in the primary region; count from here
      until aws dynamodb get-item --table-name "$(table "$s")" --key "{\"id\":{\"S\":\"$id\"}}" --region "$DR" --consistent-read --query Item.id.S --output text 2>/dev/null | grep -q "$id"; do
        (( $(awk -v s="$start" -v n="$(now)" 'BEGIN{print (n-s) > 60}') )) && { fail "$s: write not visible in $DR within 60s"; continue 3; }
        sleep 0.2
      done
      local lag; lag="$(elapsed "$start")"
      pass "$s: write #$i visible in $DR ${lag}s after it was acknowledged"; note "RPO $s #$i ${lag}s"
    done
  done
}

# --------------------------------------------------------------------------------------------------
# Warm standby: DNS fails over, then the standby is scaled up
# --------------------------------------------------------------------------------------------------
drill_warm_standby() {
  echo "== Warm standby"
  local id="ws-$(date +%s)"; post_order "$PRIMARY_URL_WS" "$id" >/dev/null
  until aws dynamodb get-item --table-name "$(table ws)" --key "{\"id\":{\"S\":\"$id\"}}" --region "$DR" --query Item.id.S --output text 2>/dev/null | grep -q "$id"; do sleep 1; done
  wait_resolve ws.dr.internal "$WS_HOST_PRIMARY" >/dev/null && pass "DNS answers the primary" || fail "DNS never answered the primary"
  local code; code="$(curl -s -o /dev/null -w '%{http_code}' "${WS_STANDBY_URL%/}/orders/$id")"
  [[ "$code" != "200" ]] && pass "standby is scaled to zero (HTTP $code before scale-up)" || fail "standby answered before scale-up"

  local t0; t0="$(now)"; set_fail ws true
  local t_dns; t_dns="$(wait_resolve ws.dr.internal "$WS_HOST_DR")" && pass "DNS failed over to the standby in ${t_dns}s" || fail "DNS did not fail over"
  aws lambda delete-function-concurrency --function-name "${PREFIX}-ws" --region "$DR"
  until [[ "$(curl -s -o /dev/null -w '%{http_code}' "${WS_STANDBY_URL%/}/orders/$id")" == "200" ]]; do
    (( $(awk -v s="$t0" -v n="$(now)" 'BEGIN{print (n-s) > '"$TIMEOUT"'}') )) && { fail "standby never served the replicated order"; return; }
    sleep 1
  done
  local total; total="$(elapsed "$t0")"
  pass "standby serves the replicated order ${total}s after the failure (DNS ${t_dns}s)"; note "RTO ws ${total}s (DNS failover ${t_dns}s + scale-up)"
  set_fail ws false
  aws lambda put-function-concurrency --function-name "${PREFIX}-ws" --reserved-concurrent-executions 0 --region "$DR" >/dev/null
}

# --------------------------------------------------------------------------------------------------
# Active-active: both regions answer; a failed region drops out of DNS
# --------------------------------------------------------------------------------------------------
drill_active_active() {
  echo "== Active-active"
  wait_resolve aa.dr.internal "$AA_HOST_PRIMARY" >/dev/null || true
  local seen; seen="$(for _ in $(seq 1 24); do resolve aa.dr.internal; done | sort -u | wc -l)"
  [[ "$seen" -ge 2 ]] && pass "both regions appear in DNS answers" || fail "only $seen distinct answer(s) with both regions healthy"
  local t0; t0="$(now)"; set_fail aa true
  local t; t="$(wait_all_dr aa.dr.internal "$AA_HOST_DR")" && pass "all answers point at the DR region after ${t}s" || fail "primary region never dropped out of DNS"
  note "RTO aa ${t:-n/a}s (failed region removed from DNS; the other region was already serving)"
  set_fail aa false
}
wait_all_dr() { # $1 = record, $2 = expected host; succeeds when 8 consecutive answers equal it
  local start; start="$(now)"
  while (( $(awk -v s="$start" -v n="$(now)" 'BEGIN{print (n-s) < '"$TIMEOUT"'}') )); do
    local distinct; distinct="$(for _ in $(seq 1 8); do resolve "$1"; done | sort -u)"
    [[ "$distinct" == "$2" ]] && { elapsed "$start"; return 0; }
  done
  return 1
}

# --------------------------------------------------------------------------------------------------
# Pilot light: the data is live, the compute is deployed on demand
# --------------------------------------------------------------------------------------------------
drill_pilot_light() {
  echo "== Pilot light"
  local id="pl-$(date +%s)"; post_order "$PRIMARY_URL_PL" "$id" >/dev/null
  until aws dynamodb get-item --table-name "$(table pl)" --key "{\"id\":{\"S\":\"$id\"}}" --region "$DR" --query Item.id.S --output text 2>/dev/null | grep -q "$id"; do sleep 1; done
  pass "replica holds the order before any compute exists in $DR"
  local t0; t0="$(now)"
  npx cdk deploy '**/*DrRecovery*' -c project="$PROJECT" -c env="$ENVIRONMENT" -c includeRecoveryStack=true --require-approval never >/dev/null 2>&1 \
    || { fail "recovery stack deploy failed"; return; }
  local url; url="$(aws cloudformation describe-stacks --stack-name "${PROJECT}-${ENVIRONMENT}-dr-recovery" --region "$DR" \
    --query "Stacks[0].Outputs[?OutputKey=='PilotLightUrl'].OutputValue" --output text)"
  until [[ "$(curl -s -o /dev/null -w '%{http_code}' "${url%/}/orders/$id")" == "200" ]]; do sleep 1; done
  local total; total="$(elapsed "$t0")"
  pass "recovery stack deployed and serving the replicated order after ${total}s"; note "RTO pl ${total}s (deploy compute stack, then serve)"
  aws cloudformation delete-stack --stack-name "${PROJECT}-${ENVIRONMENT}-dr-recovery" --region "$DR"
  aws cloudformation wait stack-delete-complete --stack-name "${PROJECT}-${ENVIRONMENT}-dr-recovery" --region "$DR"
}

# --------------------------------------------------------------------------------------------------
# Backup and restore: backup, cross-region copy, restore into the DR region
# --------------------------------------------------------------------------------------------------
wait_job() { # $1 = describe command words..., prints state when terminal
  local start; start="$(now)"
  while true; do
    local state; state="$("$@")"
    case "$state" in COMPLETED) return 0 ;; FAILED|ABORTED|EXPIRED|PARTIAL) echo "$state" >&2; return 1 ;; esac
    (( $(awk -v s="$start" -v n="$(now)" 'BEGIN{print (n-s) > 1800}') )) && return 1
    sleep 10
  done
}
drill_backup_restore() {
  echo "== Backup and restore"
  local vault; vault="$(pout PrimaryVaultName)"; local table_arn role_arn id
  table_arn="$(pout BnrTableArn)"; role_arn="$(pout BackupRoleArn)"; id="bnr-$(date +%s)"
  post_order "$(pout BNRUrl)" "$id" >/dev/null
  local t0; t0="$(now)"
  local job; job="$(aws backup start-backup-job --backup-vault-name "$vault" --resource-arn "$table_arn" --iam-role-arn "$role_arn" \
    --region "$PRIMARY" --query BackupJobId --output text)"
  wait_job aws backup describe-backup-job --backup-job-id "$job" --region "$PRIMARY" --query State --output text \
    || { fail "backup job did not complete"; return; }
  local t_backup; t_backup="$(elapsed "$t0")"; pass "backup completed in ${t_backup}s"
  local rp; rp="$(aws backup describe-backup-job --backup-job-id "$job" --region "$PRIMARY" --query RecoveryPointArn --output text)"

  # The copy is started by hand here so the drill does not wait for the schedule; the plan's copy action does the same daily.
  local dr_vault_arn; dr_vault_arn="arn:aws:backup:${DR}:$(aws sts get-caller-identity --query Account --output text):backup-vault:$(dout DrVaultName)"
  local copy; copy="$(aws backup start-copy-job --recovery-point-arn "$rp" --source-backup-vault-name "$vault" \
    --destination-backup-vault-arn "$dr_vault_arn" --iam-role-arn "$role_arn" --region "$PRIMARY" --query CopyJobId --output text)"
  wait_job aws backup describe-copy-job --copy-job-id "$copy" --region "$PRIMARY" --query CopyJob.State --output text \
    || { fail "copy job did not complete"; return; }
  local t_copy; t_copy="$(elapsed "$t0")"; pass "copy to $DR completed ${t_copy}s after the backup started"
  local copied; copied="$(aws backup describe-copy-job --copy-job-id "$copy" --region "$PRIMARY" --query CopyJob.DestinationRecoveryPointArn --output text)"

  # Restore in the DR region, into a new table: this is the recovery.
  local r0; r0="$(now)"; local target="$(table bnr)-restored"
  local meta; meta="$(aws backup get-recovery-point-restore-metadata --backup-vault-name "$(dout DrVaultName)" --recovery-point-arn "$copied" \
    --region "$DR" --query RestoreMetadata --output json | jq -c --arg t "$target" '. + {targetTableName: $t}')"
  local restore; restore="$(aws backup start-restore-job --recovery-point-arn "$copied" --iam-role-arn "$role_arn" --metadata "$meta" \
    --resource-type DynamoDB --region "$DR" --query RestoreJobId --output text)"
  wait_job aws backup describe-restore-job --restore-job-id "$restore" --region "$DR" --query Status --output text \
    || { fail "restore job did not complete"; return; }
  local t_restore; t_restore="$(elapsed "$r0")"
  aws dynamodb get-item --table-name "$target" --key "{\"id\":{\"S\":\"$id\"}}" --region "$DR" --query Item.id.S --output text | grep -q "$id" \
    && pass "restored table in $DR holds the order (restore took ${t_restore}s)" || fail "restored table does not hold the order"
  note "RPO bnr = backup interval (daily rule; this drill's on-demand backup ran ${t_backup}s)"
  note "RTO bnr >= ${t_restore}s restore + compute deploy (see pilot light) after the copy is available"
  aws dynamodb delete-table --table-name "$target" --region "$DR" >/dev/null
}

drill_cleanup() {
  echo "== Cleanup: delete recovery points so the vaults can be destroyed"
  local pair vault region arn
  for pair in "$(pout PrimaryVaultName):$PRIMARY" "$(dout DrVaultName):$DR"; do
    vault="${pair%%:*}"; region="${pair##*:}"
    for arn in $(aws backup list-recovery-points-by-backup-vault --backup-vault-name "$vault" --region "$region" --query 'RecoveryPoints[].RecoveryPointArn' --output text); do
      aws backup delete-recovery-point --backup-vault-name "$vault" --recovery-point-arn "$arn" --region "$region" && echo "deleted $arn"
    done
  done
}

run() { [[ "$ONLY" == "$1" || ( "$ONLY" == "all" && "$1" != "cleanup" ) ]] && "drill_${1//-/_}"; true; }
echo "stacks: ${PROJECT}-${ENVIRONMENT}-dr-primary ($PRIMARY) / dr-secondary ($DR)"
run rpo; run warm-standby; run active-active; run pilot-light; run backup-restore; run cleanup

echo; echo "== Summary"; printf '%s\n' "${RESULTS[@]}"
exit "$FAILED"
