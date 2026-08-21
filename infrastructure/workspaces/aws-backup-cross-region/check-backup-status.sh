#!/bin/bash

#######################################
# check-backup-status.sh
#
# Operational health check for the AWS Backup Cross-Region (Tokyo -> Osaka)
# pattern. CDK resource names in this pattern are deterministic (see
# lib/stacks/*.ts), so every resource below is derived from --project/--env
# rather than looked up via CloudFormation outputs. A clean `cdk deploy` only
# proves the resources exist — this script checks that backups are actually
# *running*: the vaults exist, the plan's CopyAction targets Osaka, a backup
# selection is attached, and recent backup/copy jobs completed successfully
# rather than failing silently.
#
# Requires: aws CLI, jq.
#
# Usage:
#   ./check-backup-status.sh --project PROJECT --env ENV [OPTIONS]
#
# Examples:
#   ./check-backup-status.sh --project myproject --env dev
#   ./check-backup-status.sh --project myproject --env dev --days 7
#######################################

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

PROJECT=""
ENVIRONMENT=""
PROFILE=""
TOKYO_REGION="ap-northeast-1"
OSAKA_REGION="ap-northeast-3"
DAYS=2
fail_count=0

print_message() {
    echo -e "${1}${2}${NC}"
}

ok()   { print_message "$GREEN" "OK    $1"; }
warn() { print_message "$YELLOW" "WARN  $1"; }
ng()   { print_message "$RED" "NG    $1"; fail_count=$((fail_count + 1)); }
section() { echo; print_message "$BLUE" "== $1 =="; }

usage() {
    cat << EOF
Usage: $0 --project PROJECT --env ENV [OPTIONS]

Check whether the AWS Backup Cross-Region (Tokyo -> Osaka) pattern is
actually protecting resources: vaults exist, the plan's CopyAction targets
Osaka, a backup selection is attached, and recent backup + cross-region copy
jobs completed successfully.

OPTIONS:
    -p, --project PROJECT        Project name (required)
    -e, --env ENV                 Environment name, e.g. dev/stg/prd (required)
    --profile PROFILE             AWS CLI profile (default: <project>-<env>)
    --tokyo-region REGION         Primary region (default: ap-northeast-1)
    --osaka-region REGION         Destination region (default: ap-northeast-3)
    --days N                      Lookback window for recent jobs, in days (default: 2)
    -h, --help                    Show this help message

EXAMPLES:
    # Check today's/yesterday's backup and copy jobs
    $0 --project myproject --env dev

    # Widen the lookback window to a week
    $0 --project myproject --env dev --days 7
EOF
    exit 1
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help)
                usage
                ;;
            -p|--project)
                PROJECT="$2"
                shift 2
                ;;
            -e|--env)
                ENVIRONMENT="$2"
                shift 2
                ;;
            --profile)
                PROFILE="$2"
                shift 2
                ;;
            --tokyo-region)
                TOKYO_REGION="$2"
                shift 2
                ;;
            --osaka-region)
                OSAKA_REGION="$2"
                shift 2
                ;;
            --days)
                DAYS="$2"
                shift 2
                ;;
            *)
                print_message "$RED" "Unknown option: $1"
                usage
                ;;
        esac
    done
}

validate_args() {
    if [ -z "$PROJECT" ] || [ -z "$ENVIRONMENT" ]; then
        print_message "$RED" "Error: --project and --env are required"
        usage
    fi

    if [ -z "$PROFILE" ]; then
        PROFILE="${PROJECT}-${ENVIRONMENT}"
    fi

    TOKYO_VAULT="${PROJECT}-${ENVIRONMENT}-backup-tokyo"
    OSAKA_VAULT="${PROJECT}-${ENVIRONMENT}-backup-osaka"
    PLAN_NAME="${PROJECT}-${ENVIRONMENT}-backup-plan"
    # `date -d` is GNU coreutils (Linux devcontainer); this script is not intended for macOS.
    SINCE=$(date -u -d "-${DAYS} days" +%Y-%m-%dT%H:%M:%SZ)
}

check_requirements() {
    for cmd in aws jq; do
        if ! command -v "$cmd" &> /dev/null; then
            print_message "$RED" "Error: ${cmd} is not installed"
            exit 1
        fi
    done
}

# Wraps `aws` with the resolved --profile for this script; region is passed explicitly per call.
aws_cmd() {
    local args=("$@")
    if [ -n "$PROFILE" ]; then
        args+=(--profile "$PROFILE")
    fi
    aws "${args[@]}"
}

verify_credentials() {
    print_message "$BLUE" "Verifying AWS credentials (profile: ${PROFILE})..."
    if ! aws_cmd sts get-caller-identity --region "$TOKYO_REGION" > /dev/null; then
        print_message "$RED" "Error: could not authenticate with profile '${PROFILE}'"
        exit 1
    fi
}

# Sets TOKYO_VAULT_JSON / OSAKA_VAULT_JSON (empty string if not found) for later steps.
check_vaults() {
    section "Backup vaults"

    TOKYO_VAULT_JSON=$(aws_cmd backup describe-backup-vault --region "$TOKYO_REGION" \
        --backup-vault-name "$TOKYO_VAULT" 2>/dev/null) || TOKYO_VAULT_JSON=""
    if [ -n "$TOKYO_VAULT_JSON" ]; then
        local rp_count
        rp_count=$(echo "$TOKYO_VAULT_JSON" | jq -r '.NumberOfRecoveryPoints')
        ok "Tokyo vault '${TOKYO_VAULT}' exists (${rp_count} recovery point(s))"
    else
        ng "Tokyo vault '${TOKYO_VAULT}' not found in ${TOKYO_REGION} — is AwsBackupCrrTokyoStack deployed?"
    fi

    OSAKA_VAULT_JSON=$(aws_cmd backup describe-backup-vault --region "$OSAKA_REGION" \
        --backup-vault-name "$OSAKA_VAULT" 2>/dev/null) || OSAKA_VAULT_JSON=""
    if [ -n "$OSAKA_VAULT_JSON" ]; then
        local rp_count
        rp_count=$(echo "$OSAKA_VAULT_JSON" | jq -r '.NumberOfRecoveryPoints')
        ok "Osaka vault '${OSAKA_VAULT}' exists (${rp_count} recovery point(s))"
    else
        ng "Osaka vault '${OSAKA_VAULT}' not found in ${OSAKA_REGION} — is AwsBackupCrrOsakaStack deployed?"
    fi
}

# Confirms the plan exists, its rule's CopyAction targets the Osaka vault, and a
# selection is attached. Sets PLAN_ID (empty string if not found).
check_plan() {
    section "Backup plan"

    PLAN_ID=$(aws_cmd backup list-backup-plans --region "$TOKYO_REGION" \
        --query "BackupPlansList[?BackupPlanName=='${PLAN_NAME}'].BackupPlanId | [0]" \
        --output text 2>/dev/null) || PLAN_ID=""
    if [ -z "$PLAN_ID" ] || [ "$PLAN_ID" = "None" ]; then
        ng "Backup plan '${PLAN_NAME}' not found in ${TOKYO_REGION}"
        PLAN_ID=""
        return
    fi
    ok "Backup plan '${PLAN_NAME}' exists (id=${PLAN_ID})"

    local plan_detail copy_target
    plan_detail=$(aws_cmd backup get-backup-plan --region "$TOKYO_REGION" \
        --backup-plan-id "$PLAN_ID" 2>/dev/null) || plan_detail=""
    copy_target=$(echo "$plan_detail" | jq -r '.BackupPlan.Rules[0].CopyActions[0].DestinationBackupVaultArn // empty' 2>/dev/null) || copy_target=""
    if [ -n "$copy_target" ]; then
        if [[ "$copy_target" == *":${OSAKA_REGION}:"* && "$copy_target" == *"$OSAKA_VAULT" ]]; then
            ok "Rule's CopyAction targets the Osaka vault (${copy_target})"
        else
            ng "Rule's CopyAction targets an unexpected vault: ${copy_target}"
        fi
    else
        ng "Plan rule has no CopyAction — recovery points would stay in Tokyo only"
    fi

    local selection_count
    selection_count=$(aws_cmd backup list-backup-selections --region "$TOKYO_REGION" \
        --backup-plan-id "$PLAN_ID" --query 'length(BackupSelectionsList)' \
        --output text 2>/dev/null) || selection_count=0
    if [ "$selection_count" -ge 1 ] 2>/dev/null; then
        ok "${selection_count} backup selection(s) attached to the plan"
    else
        ng "No backup selections attached to the plan — nothing will actually be backed up"
    fi
}

check_backup_jobs() {
    section "Recent backup jobs (since ${SINCE})"

    local backup_jobs total completed failed running
    backup_jobs=$(aws_cmd backup list-backup-jobs --region "$TOKYO_REGION" \
        --by-backup-vault-name "$TOKYO_VAULT" --by-created-after "$SINCE" \
        --query 'BackupJobs' --output json 2>/dev/null) || backup_jobs="[]"
    total=$(echo "$backup_jobs" | jq 'length' 2>/dev/null) || total=0

    if [ "$total" -eq 0 ]; then
        warn "No backup jobs found in the last ${DAYS} day(s) — nothing has run yet, or the schedule hasn't fired since deploy"
        return
    fi
    completed=$(echo "$backup_jobs" | jq '[.[] | select(.State=="COMPLETED")] | length')
    failed=$(echo "$backup_jobs" | jq '[.[] | select(.State=="FAILED" or .State=="EXPIRED" or .State=="ABORTED")] | length')
    running=$(echo "$backup_jobs" | jq '[.[] | select(.State=="RUNNING" or .State=="CREATED" or .State=="PENDING")] | length')
    if [ "$completed" -gt 0 ]; then
        ok "${completed}/${total} backup job(s) COMPLETED, ${running} running, ${failed} failed/expired/aborted"
    elif [ "$running" -gt 0 ]; then
        warn "${running}/${total} backup job(s) still RUNNING, none COMPLETED yet, ${failed} failed/expired/aborted"
    else
        ng "${total} backup job(s) found but none COMPLETED (${failed} failed/expired/aborted)"
    fi
}

check_copy_jobs() {
    section "Recent copy jobs (since ${SINCE})"

    if [ -z "$OSAKA_VAULT_JSON" ]; then
        warn "Skipped — Osaka vault was not found above"
        return
    fi

    local osaka_vault_arn copy_jobs total completed failed running
    osaka_vault_arn=$(echo "$OSAKA_VAULT_JSON" | jq -r '.BackupVaultArn')
    copy_jobs=$(aws_cmd backup list-copy-jobs --region "$TOKYO_REGION" \
        --by-destination-vault-arn "$osaka_vault_arn" --by-created-after "$SINCE" \
        --query 'CopyJobs' --output json 2>/dev/null) || copy_jobs="[]"
    total=$(echo "$copy_jobs" | jq 'length' 2>/dev/null) || total=0

    if [ "$total" -eq 0 ]; then
        warn "No copy jobs found in the last ${DAYS} day(s) — copy jobs only run after a primary backup job completes"
        return
    fi
    completed=$(echo "$copy_jobs" | jq '[.[] | select(.State=="COMPLETED")] | length')
    failed=$(echo "$copy_jobs" | jq '[.[] | select(.State=="FAILED")] | length')
    running=$(echo "$copy_jobs" | jq '[.[] | select(.State=="RUNNING" or .State=="CREATED")] | length')
    if [ "$completed" -gt 0 ]; then
        ok "${completed}/${total} copy job(s) COMPLETED into Osaka, ${running} running, ${failed} failed"
    elif [ "$running" -gt 0 ]; then
        warn "${running}/${total} copy job(s) still RUNNING, none COMPLETED yet, ${failed} failed"
    else
        ng "${total} copy job(s) found but none COMPLETED (${failed} failed) — recovery points are not reaching Osaka"
    fi
}

main() {
    print_message "$BLUE" "==================================================="
    print_message "$BLUE" "  AWS Backup Cross-Region Status Check"
    print_message "$BLUE" "==================================================="
    echo

    check_requirements
    parse_args "$@"
    validate_args
    verify_credentials

    check_vaults
    check_plan
    check_backup_jobs
    check_copy_jobs

    echo
    print_message "$BLUE" "==================================================="
    if [ "$fail_count" -gt 0 ]; then
        print_message "$RED" "  ${fail_count} check(s) failed"
        print_message "$BLUE" "==================================================="
        exit 1
    fi
    print_message "$GREEN" "  All checks passed"
    print_message "$BLUE" "==================================================="
}

main "$@"
