#!/bin/bash
# filepath: infrastructure/workspaces/aws-backup-cross-region/scripts/check-backup-status.sh
#
# Operational health check for the AWS Backup Cross-Region (Tokyo -> Osaka) pattern.
# CDK resource names in this pattern are deterministic (see lib/stacks/*.ts), so every
# resource below is derived from --project/--env rather than looked up via CloudFormation
# outputs. A clean `cdk deploy` only proves the resources exist — this script checks that
# backups are actually *running*: the plan/selection are wired up, and recent backup and
# cross-region copy jobs completed successfully rather than failing silently.
#
# Usage:
#   ./check-backup-status.sh --project <project> --env <dev|stg|prd> [OPTIONS]
#
# OPTIONS:
#   --project NAME       Project name used at deploy time (required)
#   --env ENV            Environment name used at deploy time (required)
#   --profile PROFILE    AWS profile (default: <project>-<env>, matching npm run deploy)
#   --tokyo-region REGION    Primary region (default: ap-northeast-1)
#   --osaka-region REGION    Destination region (default: ap-northeast-3)
#   --days N              Lookback window for recent backup/copy jobs, in days (default: 2)
#   -h, --help            Show this help message
#
# Examples:
#   ./check-backup-status.sh --project backup-crr-demo --env dev
#   ./check-backup-status.sh --project backup-crr-demo --env dev --days 7
#
# Requires: aws cli v2, jq
# Exit code: 0 if every check passes, 1 if any check fails.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT=""
ENV=""
PROFILE=""
TOKYO_REGION="ap-northeast-1"
OSAKA_REGION="ap-northeast-3"
DAYS=2

fail_count=0

ok() { printf "${GREEN}OK${NC}    %s\n" "$1"; }
warn() { printf "${YELLOW}WARN${NC}  %s\n" "$1"; }
ng() {
    printf "${RED}NG${NC}    %s\n" "$1"
    fail_count=$((fail_count + 1))
}
section() { printf "\n${BLUE}== %s ==${NC}\n" "$1"; }

usage() {
    cat <<EOF
Usage: $0 --project NAME --env ENV [OPTIONS]

Check whether the AWS Backup Cross-Region (Tokyo -> Osaka) pattern is actually
protecting resources: vaults exist, the plan/selection are configured, and
recent backup + cross-region copy jobs completed successfully.

OPTIONS:
    -h, --help              Show this help message
    --project NAME          Project name used at deploy time (required)
    --env ENV               Environment name used at deploy time (required)
    --profile PROFILE       AWS profile (default: <project>-<env>)
    --tokyo-region REGION   Primary region (default: ap-northeast-1)
    --osaka-region REGION   Destination region (default: ap-northeast-3)
    --days N                Lookback window for recent jobs, in days (default: 2)

EXAMPLES:
    $0 --project backup-crr-demo --env dev
    $0 --project backup-crr-demo --env dev --days 7 --profile myprofile
EOF
    exit 1
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help) usage ;;
        --project) PROJECT="$2"; shift 2 ;;
        --env) ENV="$2"; shift 2 ;;
        --profile) PROFILE="$2"; shift 2 ;;
        --tokyo-region) TOKYO_REGION="$2"; shift 2 ;;
        --osaka-region) OSAKA_REGION="$2"; shift 2 ;;
        --days) DAYS="$2"; shift 2 ;;
        *) printf "${RED}Unknown option: %s${NC}\n" "$1"; usage ;;
    esac
done

if [ -z "$PROJECT" ] || [ -z "$ENV" ]; then
    printf "${RED}Error: --project and --env are required${NC}\n"
    usage
fi

if [ -z "$PROFILE" ]; then
    PROFILE="${PROJECT}-${ENV}"
fi

if ! command -v aws &>/dev/null; then
    printf "${RED}Error: aws cli is not installed${NC}\n"
    exit 1
fi
if ! command -v jq &>/dev/null; then
    printf "${RED}Error: jq is not installed${NC}\n"
    exit 1
fi

AWS_TOKYO=(aws --profile "$PROFILE" --region "$TOKYO_REGION")
AWS_OSAKA=(aws --profile "$PROFILE" --region "$OSAKA_REGION")

if ! "${AWS_TOKYO[@]}" sts get-caller-identity &>/dev/null; then
    printf "${RED}Error: could not authenticate with profile '%s' — check AWS credentials/SSO login${NC}\n" "$PROFILE"
    exit 1
fi

TOKYO_VAULT="${PROJECT}-${ENV}-backup-tokyo"
OSAKA_VAULT="${PROJECT}-${ENV}-backup-osaka"
PLAN_NAME="${PROJECT}-${ENV}-backup-plan"

# `date -d` is GNU coreutils (Linux devcontainer); this script is not intended for macOS.
SINCE=$(date -u -d "-${DAYS} days" +%Y-%m-%dT%H:%M:%SZ)

printf "${BLUE}===================================================${NC}\n"
printf "${BLUE}  AWS Backup Cross-Region status check${NC}\n"
printf "  project=%s env=%s profile=%s\n" "$PROJECT" "$ENV" "$PROFILE"
printf "  tokyo=%s osaka=%s lookback=%sd\n" "$TOKYO_REGION" "$OSAKA_REGION" "$DAYS"
printf "${BLUE}===================================================${NC}\n"

# ── 1. Vaults exist and are reachable ──────────────────────────
section "Backup vaults"

tokyo_vault_json=$("${AWS_TOKYO[@]}" backup describe-backup-vault --backup-vault-name "$TOKYO_VAULT" 2>/dev/null) || tokyo_vault_json=""
if [ -n "$tokyo_vault_json" ]; then
    rp_count=$(echo "$tokyo_vault_json" | jq -r '.NumberOfRecoveryPoints')
    ok "Tokyo vault '$TOKYO_VAULT' exists ($rp_count recovery point(s))"
else
    ng "Tokyo vault '$TOKYO_VAULT' not found in $TOKYO_REGION — is AwsBackupCrrTokyoStack deployed?"
fi

osaka_vault_json=$("${AWS_OSAKA[@]}" backup describe-backup-vault --backup-vault-name "$OSAKA_VAULT" 2>/dev/null) || osaka_vault_json=""
if [ -n "$osaka_vault_json" ]; then
    rp_count=$(echo "$osaka_vault_json" | jq -r '.NumberOfRecoveryPoints')
    ok "Osaka vault '$OSAKA_VAULT' exists ($rp_count recovery point(s))"
else
    ng "Osaka vault '$OSAKA_VAULT' not found in $OSAKA_REGION — is AwsBackupCrrOsakaStack deployed?"
fi

# ── 2. Backup plan + copy action target the Osaka vault ───────
section "Backup plan"

plan_id=$("${AWS_TOKYO[@]}" backup list-backup-plans \
    --query "BackupPlansList[?BackupPlanName=='${PLAN_NAME}'].BackupPlanId | [0]" \
    --output text 2>/dev/null) || plan_id=""
if [ -z "$plan_id" ] || [ "$plan_id" = "None" ]; then
    ng "Backup plan '$PLAN_NAME' not found in $TOKYO_REGION"
else
    ok "Backup plan '$PLAN_NAME' exists (id=$plan_id)"

    plan_detail=$("${AWS_TOKYO[@]}" backup get-backup-plan --backup-plan-id "$plan_id" 2>/dev/null) || plan_detail=""
    copy_target=$(echo "$plan_detail" | jq -r '.BackupPlan.Rules[0].CopyActions[0].DestinationBackupVaultArn // empty' 2>/dev/null) || copy_target=""
    if [ -n "$copy_target" ]; then
        if [[ "$copy_target" == *":$OSAKA_REGION:"* && "$copy_target" == *"$OSAKA_VAULT" ]]; then
            ok "Rule's CopyAction targets the Osaka vault ($copy_target)"
        else
            ng "Rule's CopyAction targets an unexpected vault: $copy_target"
        fi
    else
        ng "Plan rule has no CopyAction — recovery points would stay in Tokyo only"
    fi

    selection_count=$("${AWS_TOKYO[@]}" backup list-backup-selections --backup-plan-id "$plan_id" \
        --query 'length(BackupSelectionsList)' --output text 2>/dev/null) || selection_count=0
    if [ "$selection_count" -ge 1 ] 2>/dev/null; then
        ok "$selection_count backup selection(s) attached to the plan"
    else
        ng "No backup selections attached to the plan — nothing will actually be backed up"
    fi
fi

# ── 3. Recent backup jobs (Tokyo) actually completed ───────────
section "Recent backup jobs (since ${SINCE})"

backup_jobs=$("${AWS_TOKYO[@]}" backup list-backup-jobs --by-backup-vault-name "$TOKYO_VAULT" \
    --by-created-after "$SINCE" --query 'BackupJobs' --output json 2>/dev/null) || backup_jobs="[]"
total=$(echo "$backup_jobs" | jq 'length' 2>/dev/null) || total=0
if [ "$total" -eq 0 ]; then
    warn "No backup jobs found in the last ${DAYS} day(s) — nothing has run yet, or the schedule hasn't fired since deploy"
else
    completed=$(echo "$backup_jobs" | jq '[.[] | select(.State=="COMPLETED")] | length')
    failed=$(echo "$backup_jobs" | jq '[.[] | select(.State=="FAILED" or .State=="EXPIRED" or .State=="ABORTED")] | length')
    running=$(echo "$backup_jobs" | jq '[.[] | select(.State=="RUNNING" or .State=="CREATED" or .State=="PENDING")] | length')
    if [ "$completed" -gt 0 ]; then
        ok "$completed/$total backup job(s) COMPLETED, $running running, $failed failed/expired/aborted"
    elif [ "$running" -gt 0 ]; then
        warn "$running/$total backup job(s) still RUNNING, none COMPLETED yet, $failed failed/expired/aborted"
    else
        ng "$total backup job(s) found but none COMPLETED ($failed failed/expired/aborted)"
    fi
fi

# ── 4. Recent copy jobs actually landed in Osaka ────────────────
section "Recent copy jobs (since ${SINCE})"

if [ -n "$osaka_vault_json" ]; then
    osaka_vault_arn=$(echo "$osaka_vault_json" | jq -r '.BackupVaultArn')
    copy_jobs=$("${AWS_TOKYO[@]}" backup list-copy-jobs --by-destination-vault-arn "$osaka_vault_arn" \
        --by-created-after "$SINCE" --query 'CopyJobs' --output json 2>/dev/null) || copy_jobs="[]"
    total=$(echo "$copy_jobs" | jq 'length' 2>/dev/null) || total=0
    if [ "$total" -eq 0 ]; then
        warn "No copy jobs found in the last ${DAYS} day(s) — copy jobs only run after a primary backup job completes"
    else
        completed=$(echo "$copy_jobs" | jq '[.[] | select(.State=="COMPLETED")] | length')
        failed=$(echo "$copy_jobs" | jq '[.[] | select(.State=="FAILED")] | length')
        running=$(echo "$copy_jobs" | jq '[.[] | select(.State=="RUNNING" or .State=="CREATED")] | length')
        if [ "$completed" -gt 0 ]; then
            ok "$completed/$total copy job(s) COMPLETED into Osaka, $running running, $failed failed"
        elif [ "$running" -gt 0 ]; then
            warn "$running/$total copy job(s) still RUNNING, none COMPLETED yet, $failed failed"
        else
            ng "$total copy job(s) found but none COMPLETED ($failed failed) — recovery points are not reaching Osaka"
        fi
    fi
else
    warn "Skipped — Osaka vault was not found above"
fi

printf "\n${BLUE}===================================================${NC}\n"
if [ "$fail_count" -gt 0 ]; then
    printf "${RED}%s check(s) failed${NC}\n" "$fail_count"
    exit 1
fi
printf "${GREEN}All checks passed${NC}\n"
