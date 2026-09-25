#!/bin/bash

#######################################
# test-rotation.sh
#
# End-to-end check of Secrets Manager rotation for Aurora. `cdk deploy` succeeding proves nothing:
# a rotation that cannot reach the database or Secrets Manager fails only when it runs (often days
# later, at the first scheduled rotation). This runs the rotations for real and asserts that the
# new credentials work:
#
#   0. bootstrap   creates the application database user (a one-time post-deploy step)
#   1. baseline    the sample consumer connects as `appuser`
#   2. app rotate  alternating users: AWSCURRENT flips to the other user (`appuser` <-> `appuser_clone`) with a
#                  NEW password, the old credentials are kept as AWSPREVIOUS, and the consumer switches to
#                  the new user WITHOUT a single failed query in between (the RDS Data API caches a secret for
#                  about two minutes, during which the previous credentials must keep working)
#   3. app rotate  flips back (the two users alternate)
#   4. master      single-user rotation: a new master password that still works
#
# The consumer and the checks use the RDS Data API, so they need no network path to the database.
#
# Requires: aws CLI, jq, sha256sum.
#
# Usage:
#   ./test-rotation.sh --project PROJECT --env ENV [OPTIONS]
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
REGION="ap-northeast-1"
STACK_NAME=""
TIMEOUT=600
INTERVAL=15
DESTROY=false

CLUSTER_ARN=""
MASTER_ARN=""
APP_ARN=""
DB_NAME=""
APP_USER=""
FUNCTION=""
PASS=0
FAIL=0

print_message() {
    echo -e "${1}${2}${NC}"
}

usage() {
    cat << EOF
Usage: $0 --project PROJECT --env ENV [OPTIONS]

Rotate the application and master secrets for real and assert that the new credentials work.

OPTIONS:
    -p, --project PROJECT     Project name (required)
    -e, --env ENV             Environment name, e.g. dev/stg/prd (required)
    --profile PROFILE         AWS CLI profile (default: <project>-<env>)
    --region REGION           AWS region (default: ap-northeast-1)
    --stack-name NAME         CloudFormation stack (default: <project>-<env>-secrets-rotation-aurora)
    --timeout SECONDS         Max seconds to wait for each rotation (default: 600)
    --destroy                 Delete the stack afterwards and force-delete its two secrets
    -h, --help                Show this help message
EOF
    exit 1
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -p|--project) PROJECT="$2"; shift 2 ;;
            -e|--env) ENVIRONMENT="$2"; shift 2 ;;
            --profile) PROFILE="$2"; shift 2 ;;
            --region) REGION="$2"; shift 2 ;;
            --stack-name) STACK_NAME="$2"; shift 2 ;;
            --timeout) TIMEOUT="$2"; shift 2 ;;
            --destroy) DESTROY=true; shift ;;
            -h|--help) usage ;;
            *) print_message "$RED" "Unknown option: $1"; usage ;;
        esac
    done
}

validate_args() {
    if [[ -z "$PROJECT" || -z "$ENVIRONMENT" ]]; then
        print_message "$RED" "Error: --project and --env are required"
        usage
    fi
    PROFILE="${PROFILE:-${PROJECT}-${ENVIRONMENT}}"
    STACK_NAME="${STACK_NAME:-${PROJECT}-${ENVIRONMENT}-secrets-rotation-aurora}"
}

check_requirements() {
    local missing=0
    for cmd in aws jq sha256sum; do
        if ! command -v "$cmd" > /dev/null 2>&1; then
            print_message "$RED" "Error: required command not found: $cmd"
            missing=1
        fi
    done
    [[ $missing -eq 0 ]] || exit 1
}

aws_cmd() {
    aws --profile "$PROFILE" --region "$REGION" "$@"
}

verify_credentials() {
    if ! aws_cmd sts get-caller-identity > /dev/null 2>&1; then
        print_message "$RED" "Error: cannot use AWS profile '$PROFILE'. Run: aws sso login --profile $PROFILE"
        exit 1
    fi
}

check() {
    local name="$1" ok="$2" detail="${3:-}"
    if [[ "$ok" == "true" ]]; then
        PASS=$((PASS + 1)); print_message "$GREEN" "  PASS  $name"
    else
        FAIL=$((FAIL + 1)); print_message "$RED" "  FAIL  $name ${detail:+($detail)}"
    fi
}

# Stack output keys are prefixed by the CDK Stage construct path, so match on the suffix.
stack_output() {
    aws_cmd cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?ends_with(OutputKey, '$1')].OutputValue | [0]" --output text
}

load_stack_info() {
    print_message "$BLUE" "==> Reading stack outputs from $STACK_NAME"
    CLUSTER_ARN="$(stack_output ClusterArn)"
    MASTER_ARN="$(stack_output MasterSecretArn)"
    APP_ARN="$(stack_output AppSecretArn)"
    DB_NAME="$(stack_output DatabaseName)"
    APP_USER="$(stack_output AppUsername)"
    FUNCTION="$(stack_output WhoamiFunctionName)"
    if [[ -z "$CLUSTER_ARN" || "$CLUSTER_ARN" == "None" ]]; then
        print_message "$RED" "Error: stack outputs not found. Is $STACK_NAME deployed in $REGION?"
        exit 1
    fi
    echo "    Cluster: ${CLUSTER_ARN##*:}"
}

# sql SECRET_ARN STATEMENT -> prints the first column of the first row (or nothing)
sql() {
    aws_cmd rds-data execute-statement --resource-arn "$CLUSTER_ARN" --secret-arn "$1" --database "$DB_NAME" --sql "$2" \
        --query 'records[0][0].stringValue' --output text 2> /dev/null | sed 's/^None$//'
}

# Fingerprint (never the value) of the password in a secret version.
password_fingerprint() {
    aws_cmd secretsmanager get-secret-value --secret-id "$1" ${2:+--version-stage "$2"} --query SecretString --output text \
        | jq -r .password | sha256sum | cut -c1-8
}

current_version() {
    aws_cmd secretsmanager describe-secret --secret-id "$1" --query 'VersionIdsToStages' --output json \
        | jq -r 'to_entries[] | select(.value | index("AWSCURRENT")) | .key'
}

consumer_user() {
    aws_cmd lambda invoke --function-name "$FUNCTION" --cli-binary-format raw-in-base64-out /tmp/test-rotation-response.json > /dev/null
    jq -r '.currentUser // .errorMessage' /tmp/test-rotation-response.json
}

# The other user of the alternating pair: appuser <-> appuser_clone
alt_user() {
    if [[ "$1" == *_clone ]]; then echo "${1%_clone}"; else echo "${1}_clone"; fi
}

secret_user() {
    aws_cmd secretsmanager get-secret-value --secret-id "$1" --query SecretString --output text | jq -r .username
}

# wait_consumer_switch EXPECTED PREVIOUS -> waits until the consumer runs as EXPECTED; every sample in between must
# be a successful query as EXPECTED or PREVIOUS. Sets SWITCH_SECONDS and SWITCH_ERRORS.
wait_consumer_switch() {
    local expected="$1" previous="$2" deadline=$((SECONDS + 600)) start=$SECONDS who
    SWITCH_ERRORS=0
    while [[ $SECONDS -lt $deadline ]]; do
        who="$(consumer_user)"
        if [[ "$who" == "$expected" ]]; then SWITCH_SECONDS=$((SECONDS - start)); return 0; fi
        if [[ "$who" != "$previous" ]]; then SWITCH_ERRORS=$((SWITCH_ERRORS + 1)); echo "    unexpected consumer response: $who"; fi
        sleep 10
    done
    SWITCH_SECONDS=$((SECONDS - start))
    return 1
}

# rotate SECRET_ARN OLD_VERSION -> starts a rotation and waits until AWSCURRENT is a different version
rotate() {
    local arn="$1" old="$2" deadline=$((SECONDS + TIMEOUT)) now
    aws_cmd secretsmanager rotate-secret --secret-id "$arn" > /dev/null
    while [[ $SECONDS -lt $deadline ]]; do
        now="$(current_version "$arn")"
        [[ "$now" != "$old" ]] && return 0
        echo "    ... rotating (AWSCURRENT still $old)"
        sleep "$INTERVAL"
    done
    return 1
}

bootstrap_app_user() {
    print_message "$BLUE" "==> Bootstrap: create the application database user (one-time, needs the master credentials)"
    local pw exists
    pw="$(aws_cmd secretsmanager get-secret-value --secret-id "$APP_ARN" --query SecretString --output text | jq -r .password)"
    exists="$(sql "$MASTER_ARN" "SELECT rolname FROM pg_roles WHERE rolname = '$APP_USER'")"
    if [[ -z "$exists" ]]; then
        sql "$MASTER_ARN" "CREATE ROLE $APP_USER LOGIN PASSWORD '$pw'" > /dev/null
        sql "$MASTER_ARN" "GRANT CONNECT ON DATABASE $DB_NAME TO $APP_USER" > /dev/null
        sql "$MASTER_ARN" "GRANT USAGE ON SCHEMA public TO $APP_USER" > /dev/null
    fi
    check "database user $APP_USER exists" "$([[ "$(sql "$MASTER_ARN" "SELECT rolname FROM pg_roles WHERE rolname = '$APP_USER'")" == "$APP_USER" ]] && echo true || echo false)"
}

run_tests() {
    bootstrap_app_user

    print_message "$BLUE" "==> Rotation is configured"
    local d
    for d in "$MASTER_ARN" "$APP_ARN"; do
        check "$(aws_cmd secretsmanager describe-secret --secret-id "$d" --query Name --output text): rotation enabled every 30 days" \
            "$([[ "$(aws_cmd secretsmanager describe-secret --secret-id "$d" --query '[RotationEnabled, RotationRules.AutomaticallyAfterDays]' --output text | tr '\t' ' ')" == "True 30" ]] && echo true || echo false)"
    done

    print_message "$BLUE" "==> Baseline: the consumer connects with the application secret"
    local u0 v0 fp0 SWITCH_SECONDS=0 SWITCH_ERRORS=0
    u0="$(secret_user "$APP_ARN")"; v0="$(current_version "$APP_ARN")"; fp0="$(password_fingerprint "$APP_ARN")"
    # A previous run may have rotated less than two minutes ago; let the Data API's secret cache catch up first.
    if wait_consumer_switch "$u0" "$(alt_user "$u0")"; then
        check "the consumer connects as $u0 (the user in AWSCURRENT)" true
    else
        check "the consumer connects as $u0 (the user in AWSCURRENT)" false "still not after ${SWITCH_SECONDS}s"
    fi

    print_message "$BLUE" "==> Rotate the application secret (alternating users)"
    local u1
    u1="$(alt_user "$u0")"
    if rotate "$APP_ARN" "$v0"; then
        local v1 fp1 prev
        v1="$(current_version "$APP_ARN")"; fp1="$(password_fingerprint "$APP_ARN")"
        check "AWSCURRENT is a new secret version" "$([[ "$v1" != "$v0" ]] && echo true || echo false)"
        check "the secret now names the other user ($u0 -> $(secret_user "$APP_ARN"))" "$([[ "$(secret_user "$APP_ARN")" == "$u1" ]] && echo true || echo false)"
        check "the password changed (fingerprint $fp0 -> $fp1)" "$([[ "$fp1" != "$fp0" ]] && echo true || echo false)"
        prev="$(aws_cmd secretsmanager describe-secret --secret-id "$APP_ARN" --query 'VersionIdsToStages' --output json | jq -r 'to_entries[] | select(.value | index("AWSPREVIOUS")) | .key')"
        check "the previous credentials are kept as AWSPREVIOUS" "$([[ "$prev" == "$v0" ]] && echo true || echo false)" "AWSPREVIOUS=$prev"
        check "the previous database role $u0 still exists (it is not dropped)" "$([[ "$(sql "$MASTER_ARN" "SELECT rolname FROM pg_roles WHERE rolname = '$u0'")" == "$u0" ]] && echo true || echo false)"
        check "the new database role $u1 exists" "$([[ "$(sql "$MASTER_ARN" "SELECT rolname FROM pg_roles WHERE rolname = '$u1'")" == "$u1" ]] && echo true || echo false)"

        echo "    waiting for the consumer to pick up the new credentials (the Data API caches a secret for a few minutes)..."
        if wait_consumer_switch "$u1" "$u0"; then
            check "the consumer switched to $u1 after ${SWITCH_SECONDS}s with NO redeploy or restart" true
        else
            check "the consumer switched to $u1" false "still not after ${SWITCH_SECONDS}s"
        fi
        check "zero downtime: no failed query while the cached old credentials were still in use" "$([[ "$SWITCH_ERRORS" == "0" ]] && echo true || echo false)" "$SWITCH_ERRORS unexpected responses"

        print_message "$BLUE" "==> Rotate again: the two users alternate"
        if rotate "$APP_ARN" "$v1"; then
            if wait_consumer_switch "$u0" "$u1"; then
                check "the consumer is back on $u0 after ${SWITCH_SECONDS}s (alternation)" true
            else
                check "the consumer is back on $u0 (alternation)" false "still not after ${SWITCH_SECONDS}s"
            fi
        else
            check "second application rotation finished within ${TIMEOUT}s" false "timeout: see the rotation Lambda logs"
        fi
    else
        check "application rotation finished within ${TIMEOUT}s" false "timeout: see the rotation Lambda logs (network path to Secrets Manager / DB?)"
    fi

    print_message "$BLUE" "==> Rotate the master secret (single user)"
    local mv0 mfp0
    mv0="$(current_version "$MASTER_ARN")"; mfp0="$(password_fingerprint "$MASTER_ARN")"
    if rotate "$MASTER_ARN" "$mv0"; then
        local mfp1 who
        mfp1="$(password_fingerprint "$MASTER_ARN")"
        who="$(sql "$MASTER_ARN" 'SELECT current_user')"
        check "the master password changed (fingerprint $mfp0 -> $mfp1)" "$([[ "$mfp1" != "$mfp0" ]] && echo true || echo false)"
        check "the NEW master credentials work (current_user = dbadmin)" "$([[ "$who" == "dbadmin" ]] && echo true || echo false)" "got: $who"
        check "the consumer still works after the master rotation" "$([[ "$(consumer_user)" == "$u0" || "$(consumer_user)" == "$u1" ]] && echo true || echo false)"
    else
        check "master rotation finished within ${TIMEOUT}s" false "timeout: see the rotation Lambda logs"
    fi
}

destroy_all() {
    print_message "$BLUE" "==> Deleting stack $STACK_NAME (Aurora takes several minutes)"
    aws_cmd cloudformation delete-stack --stack-name "$STACK_NAME"
    aws_cmd cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
    # CloudFormation schedules secrets for deletion with a recovery window that RESERVES the name, so a
    # redeploy with the same secret name would fail. Force-delete them.
    local n
    for n in "${PROJECT}-${ENVIRONMENT}-rot/master" "${PROJECT}-${ENVIRONMENT}-rot/app"; do
        aws_cmd secretsmanager delete-secret --secret-id "$n" --force-delete-without-recovery > /dev/null 2>&1 || true
    done
    echo "    stack deleted; secrets force-deleted"
}

main() {
    parse_args "$@"
    validate_args
    check_requirements
    verify_credentials
    load_stack_info
    run_tests
    [[ "$DESTROY" == true ]] && destroy_all

    echo
    if [[ $FAIL -eq 0 ]]; then
        print_message "$GREEN" "All checks passed ($PASS)"
    else
        print_message "$RED" "$FAIL check(s) failed, $PASS passed"
        exit 1
    fi
}

main "$@"
