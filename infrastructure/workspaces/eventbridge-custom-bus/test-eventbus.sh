#!/bin/bash

#######################################
# test-eventbus.sh
#
# End-to-end check of the deployed EventBridge custom bus. A clean `cdk deploy` does not show that
# each rule matches the RIGHT events and no others, so this publishes a controlled set of events and
# asserts exactly where each one lands:
#
#   E1 OrderPlaced  1500  us-east-1   -> high-value queue, audit log
#   E2 OrderPlaced    50  eu-west-1   -> Lambda (DynamoDB), audit log
#   E3 OrderPlaced  2000  eu-central-1-> high-value queue, Lambda (DynamoDB), audit log
#   E4 PaymentFailed (card_declined)  -> payment queue, audit log
#   E5 OrderCancelled 5000            -> audit log only (detail-type filter)
#   E6 OrderPlaced  9999, source other.app -> NOTHING (source filter)
#   E7 PaymentFailed (user_cancelled) -> audit log only (anything-but filter)
#
# Then it waits for the archive to hold the events, replays them into the bus (only to the
# high-value rule) and asserts that the high-value queue receives them again.
#
# Requires: aws CLI, jq.
#
# Usage:
#   ./test-eventbus.sh --project PROJECT --env ENV [OPTIONS]
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
TIMEOUT=120
ARCHIVE_TIMEOUT=1200
INTERVAL=10
SKIP_REPLAY=false
DESTROY=false

BUS=""
ARCHIVE=""
HIGH_URL=""
PAYMENT_URL=""
DLQ_URL=""
TABLE=""
AUDIT_LOG=""
RUN_ID=""
START_EPOCH=0
PASS=0
FAIL=0

print_message() {
    echo -e "${1}${2}${NC}"
}

usage() {
    cat << EOF
Usage: $0 --project PROJECT --env ENV [OPTIONS]

Publish a controlled set of events to the custom bus and assert where each one is delivered,
then replay the archive.

OPTIONS:
    -p, --project PROJECT     Project name (required)
    -e, --env ENV             Environment name, e.g. dev/stg/prd (required)
    --profile PROFILE         AWS CLI profile (default: <project>-<env>)
    --region REGION           AWS region (default: ap-northeast-1)
    --stack-name NAME         CloudFormation stack (default: <project>-<env>-eventbridge-custom-bus)
    --timeout SECONDS         Max seconds to wait for deliveries (default: 120)
    --archive-timeout SECONDS Max seconds to wait for the archive to record the events (default: 1200)
    --skip-replay             Skip the archive replay step (it can wait several minutes for the archive)
    --destroy                 Delete the stack afterwards
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
            --archive-timeout) ARCHIVE_TIMEOUT="$2"; shift 2 ;;
            --skip-replay) SKIP_REPLAY=true; shift ;;
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
    STACK_NAME="${STACK_NAME:-${PROJECT}-${ENVIRONMENT}-eventbridge-custom-bus}"
}

check_requirements() {
    local missing=0
    for cmd in aws jq; do
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
    BUS="$(stack_output EventBusName)"
    ARCHIVE="$(stack_output ArchiveName)"
    HIGH_URL="$(stack_output HighValueQueueUrl)"
    PAYMENT_URL="$(stack_output PaymentFailedQueueUrl)"
    DLQ_URL="$(stack_output TargetDlqUrl)"
    TABLE="$(stack_output ProcessedTableName)"
    AUDIT_LOG="$(stack_output AuditLogGroupName)"
    if [[ -z "$BUS" || "$BUS" == "None" ]]; then
        print_message "$RED" "Error: stack outputs not found. Is $STACK_NAME deployed in $REGION?"
        exit 1
    fi
    echo "    Bus: $BUS"
}

# entry SOURCE DETAIL_TYPE DETAIL_JSON -> one PutEvents entry
entry() {
    jq -nc --arg bus "$BUS" --arg src "$1" --arg dt "$2" --arg d "$3" '{EventBusName:$bus,Source:$src,DetailType:$dt,Detail:$d}'
}

publish_events() {
    print_message "$BLUE" "==> Publishing 7 events (run $RUN_ID)"
    local entries
    entries="$(jq -sc '.' <<< "$(
        entry app.orders OrderPlaced "{\"orderId\":\"$RUN_ID-1\",\"amount\":1500,\"region\":\"us-east-1\"}"
        entry app.orders OrderPlaced "{\"orderId\":\"$RUN_ID-2\",\"amount\":50,\"region\":\"eu-west-1\"}"
        entry app.orders OrderPlaced "{\"orderId\":\"$RUN_ID-3\",\"amount\":2000,\"region\":\"eu-central-1\"}"
        entry app.orders PaymentFailed "{\"orderId\":\"$RUN_ID-4\",\"reason\":\"card_declined\"}"
        entry app.orders OrderCancelled "{\"orderId\":\"$RUN_ID-5\",\"amount\":5000,\"region\":\"us-east-1\"}"
        entry other.app OrderPlaced "{\"orderId\":\"$RUN_ID-6\",\"amount\":9999,\"region\":\"eu-west-1\"}"
        entry app.orders PaymentFailed "{\"orderId\":\"$RUN_ID-7\",\"reason\":\"user_cancelled\"}"
    )")"
    local failed
    failed="$(aws_cmd events put-events --entries "$entries" --query FailedEntryCount --output text)"
    check "PutEvents accepted all 7 events" "$([[ "$failed" == "0" ]] && echo true || echo false)" "FailedEntryCount=$failed"
}

# drain_queue URL EXPECTED_MIN -> prints message bodies (one JSON per line) received within TIMEOUT
drain_queue() {
    local url="$1" min="$2" deadline=$((SECONDS + TIMEOUT)) bodies="" msgs count=0
    while [[ $SECONDS -lt $deadline ]]; do
        msgs="$(aws_cmd sqs receive-message --queue-url "$url" --max-number-of-messages 10 --wait-time-seconds 5 --output json)"
        if [[ "$(jq '.Messages | length // 0' <<< "$msgs")" -gt 0 ]]; then
            bodies+="$(jq -r '.Messages[].Body' <<< "$msgs")"$'\n'
            jq -r '.Messages[].ReceiptHandle' <<< "$msgs" | while read -r h; do
                aws_cmd sqs delete-message --queue-url "$url" --receipt-handle "$h"
            done
            count="$(grep -c . <<< "$bodies" || true)"
        fi
        [[ $count -ge $min ]] && break
    done
    # A short extra poll picks up extras so an unexpected duplicate/extra delivery is not missed.
    msgs="$(aws_cmd sqs receive-message --queue-url "$url" --max-number-of-messages 10 --wait-time-seconds 3 --output json)"
    if [[ "$(jq '.Messages | length // 0' <<< "$msgs")" -gt 0 ]]; then
        bodies+="$(jq -r '.Messages[].Body' <<< "$msgs")"$'\n'
    fi
    echo -n "$bodies"
}

order_ids() { jq -r --arg run "$RUN_ID" '(.orderId // .detail.orderId) | select(. != null and startswith($run))' | sort | tr '\n' ' '; }

verify_routing() {
    print_message "$BLUE" "==> HighValue rule (numeric >= 1000, detail-type OrderPlaced) -> SQS with an input transformer"
    local high got
    high="$(drain_queue "$HIGH_URL" 2)"
    got="$(order_ids <<< "$high")"
    check "high-value queue got exactly E1 and E3" "$([[ "$got" == "$RUN_ID-1 $RUN_ID-3 " ]] && echo true || echo false)" "got: $got"
    check "the message is the transformed payload (tier=high-value, no event envelope)" \
        "$([[ "$(head -n1 <<< "$high" | jq -r '[.tier, (has("detail-type"))] | join(",")')" == "high-value,false" ]] && echo true || echo false)" "$(head -n1 <<< "$high")"
    echo "    (E5 5000 is not delivered: wrong detail-type; E6 9999 is not delivered: wrong source)"

    print_message "$BLUE" "==> PaymentFailed rule (anything-but user_cancelled) -> SQS"
    local pay
    pay="$(drain_queue "$PAYMENT_URL" 1)"
    got="$(order_ids <<< "$pay")"
    check "payment queue got E4 only (E7 user_cancelled is filtered out)" "$([[ "$got" == "$RUN_ID-4 " ]] && echo true || echo false)" "got: $got"

    print_message "$BLUE" "==> EuOrders rule (prefix eu-) -> Lambda -> DynamoDB"
    local deadline=$((SECONDS + TIMEOUT)) ids=""
    while [[ $SECONDS -lt $deadline ]]; do
        ids="$(aws_cmd dynamodb scan --table-name "$TABLE" --filter-expression 'begins_with(orderId, :p)' \
            --expression-attribute-values "{\":p\":{\"S\":\"$RUN_ID\"}}" --query 'Items[].orderId.S' --output json | jq -r 'sort | join(" ")')"
        [[ "$ids" == "$RUN_ID-2 $RUN_ID-3" ]] && break
        sleep 5
    done
    check "Lambda processed E2 and E3 only (eu-*), not E1 (us) nor E6 (other source)" "$([[ "$ids" == "$RUN_ID-2 $RUN_ID-3" ]] && echo true || echo false)" "items: $ids"

    print_message "$BLUE" "==> Audit rule (every app.orders event) -> CloudWatch Logs, written by EventBridge"
    local logged="" deadline2=$((SECONDS + TIMEOUT))
    while [[ $SECONDS -lt $deadline2 ]]; do
        logged="$(aws_cmd logs filter-log-events --log-group-name "$AUDIT_LOG" --filter-pattern "\"$RUN_ID\"" --query 'events[].message' --output json \
            | jq -r '.[] | fromjson | .detail.orderId' | sort -u | tr '\n' ' ')"
        [[ "$logged" == "$RUN_ID-1 $RUN_ID-2 $RUN_ID-3 $RUN_ID-4 $RUN_ID-5 $RUN_ID-7 " ]] && break
        sleep 5
    done
    check "audit log has E1-E5 and E7, and NOT E6 (source other.app matches no rule)" \
        "$([[ "$logged" == "$RUN_ID-1 $RUN_ID-2 $RUN_ID-3 $RUN_ID-4 $RUN_ID-5 $RUN_ID-7 " ]] && echo true || echo false)" "got: $logged"

    print_message "$BLUE" "==> Delivery failures"
    local dlq
    dlq="$(aws_cmd sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)"
    check "the target DLQ is empty (every delivery succeeded)" "$([[ "$dlq" == "0" ]] && echo true || echo false)" "messages: $dlq"
}

replay_archive() {
    print_message "$BLUE" "==> Archive and replay (waiting for the archive to record the events; this can take several minutes)"
    local archive_arn deadline=$((SECONDS + ARCHIVE_TIMEOUT)) count=0
    archive_arn="$(aws_cmd events describe-archive --archive-name "$ARCHIVE" --query ArchiveArn --output text)"
    while [[ $SECONDS -lt $deadline ]]; do
        count="$(aws_cmd events describe-archive --archive-name "$ARCHIVE" --query EventCount --output text)"
        echo "    archived events so far: $count"
        [[ "$count" -ge 6 ]] && break
        sleep 30
    done
    check "the archive recorded the app.orders events (6 events; other.app is not archived)" "$([[ "$count" -ge 6 ]] && echo true || echo false)" "EventCount=$count"
    [[ "$count" -ge 6 ]] || return 0

    local bus_arn rule_arn replay_name="replay-$RUN_ID"
    bus_arn="$(aws_cmd events describe-event-bus --name "$BUS" --query Arn --output text)"
    rule_arn="$(aws_cmd events describe-rule --event-bus-name "$BUS" --name "${BUS%-orders}-high-value" --query Arn --output text)"
    aws_cmd events start-replay --replay-name "$replay_name" --event-source-arn "$archive_arn" \
        --destination "{\"Arn\":\"$bus_arn\",\"FilterArns\":[\"$rule_arn\"]}" \
        --event-start-time "$(date -u -d "@$((START_EPOCH - 60))" +%Y-%m-%dT%H:%M:%SZ)" \
        --event-end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /dev/null
    local state="" deadline2=$((SECONDS + ARCHIVE_TIMEOUT))
    while [[ $SECONDS -lt $deadline2 ]]; do
        state="$(aws_cmd events describe-replay --replay-name "$replay_name" --query State --output text)"
        echo "    replay state: $state"
        [[ "$state" == "COMPLETED" || "$state" == "FAILED" || "$state" == "CANCELLED" ]] && break
        sleep 15
    done
    check "the replay completed" "$([[ "$state" == "COMPLETED" ]] && echo true || echo false)" "state=$state"

    # Replay delivery is asynchronous: in one verification run only one of the two events had arrived
    # within two minutes of COMPLETED, so wait longer here.
    local high got TIMEOUT=240
    high="$(drain_queue "$HIGH_URL" 2)"
    got="$(order_ids <<< "$high")"
    check "the replay re-delivered E1 and E3 to the high-value queue (and only there)" "$([[ "$got" == "$RUN_ID-1 $RUN_ID-3 " ]] && echo true || echo false)" "got: $got"
    if [[ "$got" != "$RUN_ID-1 $RUN_ID-3 " ]]; then
        echo "    replay details:"
        aws_cmd events describe-replay --replay-name "$replay_name" --output json | jq -c '{State, EventStartTime, EventEndTime, EventLastReplayedTime, ReplayStartTime, ReplayEndTime}' | sed 's/^/      /'
    fi
}

main() {
    parse_args "$@"
    validate_args
    check_requirements
    verify_credentials
    load_stack_info

    RUN_ID="t$(date +%s | tail -c 7)$RANDOM"
    START_EPOCH="$(date +%s)"
    publish_events
    verify_routing
    [[ "$SKIP_REPLAY" == true ]] || replay_archive

    if [[ "$DESTROY" == true ]]; then
        print_message "$BLUE" "==> Deleting stack $STACK_NAME"
        aws_cmd cloudformation delete-stack --stack-name "$STACK_NAME"
        aws_cmd cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
    fi

    echo
    if [[ $FAIL -eq 0 ]]; then
        print_message "$GREEN" "All checks passed ($PASS)"
    else
        print_message "$RED" "$FAIL check(s) failed, $PASS passed"
        exit 1
    fi
}

main "$@"
