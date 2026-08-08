#!/bin/bash

#######################################
# write-test-logs.sh
#
# Writes test log events into the demo CloudWatch Log Group created by
# SnsBasicStack, to exercise the
# CloudWatch Logs -> Lambda (cwlogs-to-sns) -> SNS (LogAlertTopic) -> Lambda (log-alert-notifier)
# chain.
#
# The log group is named:
#   /<project>/<env>/sns-basic/app
#
# By default, after writing the test events, this script also polls the
# downstream Lambda functions' own CloudWatch Logs (cwlogs-to-sns and
# log-alert-notifier) to confirm the whole chain actually fired end to end.
# Use --no-check to skip this and only write the source log events.
#
# Usage:
#   ./write-test-logs.sh --project PROJECT --env ENV [OPTIONS]
#
# Examples:
#   ./write-test-logs.sh --project myproject --env dev
#   ./write-test-logs.sh --project myproject --env dev --count 20 --message "load test"
#   ./write-test-logs.sh --project myproject --env dev --no-check
#   ./write-test-logs.sh --project myproject --env dev --timeout 120 --interval 10
#######################################

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
PROJECT=""
ENVIRONMENT=""
PROFILE=""
REGION=""
COUNT=1
MESSAGE=""
CHECK=true
TIMEOUT=60
INTERVAL=5

print_message() {
    echo -e "${1}${2}${NC}"
}

usage() {
    cat << EOF
Usage: $0 --project PROJECT --env ENV [OPTIONS]

Write test log events to the demo CloudWatch Log Group created by
SnsBasicStack (/<project>/<env>/sns-basic/app), to trigger the
CloudWatch Logs -> Lambda -> SNS -> Lambda alerting chain.

OPTIONS:
    -p, --project PROJECT   Project name (required)
    -e, --env ENV           Environment name, e.g. dev/stg/prd (required)
    --profile PROFILE       AWS CLI profile (default: <project>-<env>)
    --region REGION         AWS region (default: profile's configured region)
    -c, --count N           Number of log events to write (default: 1)
    -m, --message MESSAGE   Log message body (default: "hello sns-basic from <log-group>")
    --no-check              Only write the source log events; skip polling the
                            downstream Lambda log groups for confirmation
    --timeout N             Max seconds to poll for downstream confirmation (default: 60)
    --interval N            Seconds between polling attempts (default: 5)
    -h, --help              Show this help message

EXAMPLES:
    # Write 1 test event to the demo log group and confirm the chain fired
    $0 --project myproject --env dev

    # Write 20 events with a custom message
    $0 --project myproject --env dev --count 20 --message "load test"

    # Just write events, don't wait around for confirmation
    $0 --project myproject --env dev --no-check
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
            --region)
                REGION="$2"
                shift 2
                ;;
            -c|--count)
                COUNT="$2"
                shift 2
                ;;
            -m|--message)
                MESSAGE="$2"
                shift 2
                ;;
            --no-check)
                CHECK=false
                shift
                ;;
            --timeout)
                TIMEOUT="$2"
                shift 2
                ;;
            --interval)
                INTERVAL="$2"
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

    if ! [[ "$COUNT" =~ ^[0-9]+$ ]] || [ "$COUNT" -lt 1 ]; then
        print_message "$RED" "Error: count must be a positive integer"
        exit 1
    fi

    if ! [[ "$TIMEOUT" =~ ^[0-9]+$ ]] || [ "$TIMEOUT" -lt 1 ]; then
        print_message "$RED" "Error: --timeout must be a positive integer"
        exit 1
    fi

    if ! [[ "$INTERVAL" =~ ^[0-9]+$ ]] || [ "$INTERVAL" -lt 1 ]; then
        print_message "$RED" "Error: --interval must be a positive integer"
        exit 1
    fi
}

check_requirements() {
    if ! command -v aws &> /dev/null; then
        print_message "$RED" "Error: aws CLI is not installed"
        exit 1
    fi

    if ! command -v jq &> /dev/null; then
        print_message "$RED" "Error: jq is not installed"
        exit 1
    fi
}

# Wraps `aws` with the resolved --profile/--region for this script
aws_cmd() {
    local args=("$@")
    if [ -n "$PROFILE" ]; then
        args+=(--profile "$PROFILE")
    fi
    if [ -n "$REGION" ]; then
        args+=(--region "$REGION")
    fi
    aws "${args[@]}"
}

verify_credentials() {
    print_message "$BLUE" "Verifying AWS credentials (profile: ${PROFILE})..."
    if ! aws_cmd sts get-caller-identity > /dev/null; then
        print_message "$RED" "Error: could not authenticate with profile '${PROFILE}'"
        exit 1
    fi
}

# Confirms the demo log group exists (created by SnsBasicStack)
find_log_group() {
    LOG_GROUP="/${PROJECT}/${ENVIRONMENT}/sns-basic/app"

    print_message "$BLUE" "Looking up log group: ${LOG_GROUP}"

    local found
    found=$(aws_cmd logs describe-log-groups \
        --log-group-name-prefix "$LOG_GROUP" \
        --query "logGroups[?logGroupName=='${LOG_GROUP}'] | length(@)" \
        --output text)

    if [ "$found" -eq 0 ]; then
        print_message "$RED" "Error: log group '${LOG_GROUP}' not found"
        print_message "$YELLOW" "Make sure SnsBasicStack has been deployed for this project/env"
        exit 1
    fi

    print_message "$GREEN" "Found log group: ${LOG_GROUP}"
}

# Writes $COUNT log events to the demo log group.
# Every message is tagged with $RUN_ID so downstream logs can be matched
# back to this specific run (see check_downstream_chain).
write_test_logs() {
    local log_stream="test-stream-$(date +%Y%m%d%H%M%S)"
    local message="${MESSAGE:-hello sns-basic from ${LOG_GROUP}}"

    print_message "$BLUE" "  -> ${LOG_GROUP} (stream: ${log_stream}, run: ${RUN_ID})"

    aws_cmd logs create-log-stream \
        --log-group-name "$LOG_GROUP" \
        --log-stream-name "$log_stream"

    START_MS=$(($(date +%s%N) / 1000000))

    local events_json
    events_json=$(jq -n --argjson count "$COUNT" --argjson start "$START_MS" --arg msg "$message" --arg run_id "$RUN_ID" '
        [range($count) | {timestamp: ($start + .), message: "\($msg) #\(. + 1) [run:\($run_id)]"}]
    ')

    aws_cmd logs put-log-events \
        --log-group-name "$LOG_GROUP" \
        --log-stream-name "$log_stream" \
        --log-events "$events_json" > /dev/null
}

# Resolves the CloudWatch Log Group actually attached to a Lambda function
# (works whether the function uses its default log group or a custom one).
resolve_function_log_group() {
    local function_name=$1
    aws_cmd lambda get-function-configuration \
        --function-name "$function_name" \
        --query 'LoggingConfig.LogGroup' \
        --output text 2>/dev/null
}

# Polls a log group for a line matching $pattern with a timestamp at or
# after $START_MS, up to $TIMEOUT seconds. Prints the matching line(s) and
# returns 0 on success, 1 on timeout.
poll_log_group_for_pattern() {
    local log_group=$1
    local pattern=$2
    local label=$3
    local elapsed=0

    while [ "$elapsed" -lt "$TIMEOUT" ]; do
        local matches
        matches=$(aws_cmd logs filter-log-events \
            --log-group-name "$log_group" \
            --start-time "$START_MS" \
            --filter-pattern "$pattern" \
            --query 'events[].message' \
            --output text 2>/dev/null || true)

        if [ -n "$matches" ]; then
            print_message "$GREEN" "  [OK] ${label}"
            echo "$matches" | sed 's/^/        /'
            return 0
        fi

        sleep "$INTERVAL"
        elapsed=$((elapsed + INTERVAL))
        print_message "$YELLOW" "  ... still waiting for ${label} (${elapsed}s/${TIMEOUT}s)"
    done

    print_message "$RED" "  [TIMEOUT] ${label}"
    return 1
}

# Confirms the full chain fired by checking the downstream Lambda functions'
# own CloudWatch Logs for evidence tied to this run:
#   1. cwlogs-to-sns logged that it published a summary to SNS
#   2. log-alert-notifier received a message containing our RUN_ID
check_downstream_chain() {
    print_message "$BLUE" "Waiting for the CloudWatch Logs -> Lambda -> SNS -> Lambda chain to fire..."
    print_message "$BLUE" "(polling every ${INTERVAL}s, up to ${TIMEOUT}s per stage)"
    echo

    local processor_function="${PROJECT}-${ENVIRONMENT}-cwlogs-to-sns"
    local notifier_function="${PROJECT}-${ENVIRONMENT}-log-alert-notifier"

    local processor_log_group notifier_log_group
    processor_log_group=$(resolve_function_log_group "$processor_function")
    notifier_log_group=$(resolve_function_log_group "$notifier_function")

    local ok=true

    if [ -z "$processor_log_group" ] || [ "$processor_log_group" == "None" ]; then
        print_message "$RED" "  [SKIP] Could not resolve log group for function '${processor_function}'"
        ok=false
    else
        poll_log_group_for_pattern "$processor_log_group" "\"Published summary to SNS\"" \
            "cwlogs-to-sns published a summary to LogAlertTopic" || ok=false
    fi

    if [ -z "$notifier_log_group" ] || [ "$notifier_log_group" == "None" ]; then
        print_message "$RED" "  [SKIP] Could not resolve log group for function '${notifier_function}'"
        ok=false
    else
        poll_log_group_for_pattern "$notifier_log_group" "\"run:${RUN_ID}\"" \
            "log-alert-notifier received this run's message" || ok=false
    fi

    echo
    if [ "$ok" = true ]; then
        print_message "$GREEN" "Confirmed: the full chain fired for this run."
    else
        print_message "$YELLOW" "Could not confirm the full chain within ${TIMEOUT}s."
        print_message "$YELLOW" "This can just mean delivery is still in flight -- check the Lambda"
        print_message "$YELLOW" "log groups manually, or re-run with a longer --timeout."
    fi
}

main() {
    print_message "$BLUE" "==================================================="
    print_message "$BLUE" "  SNS Basic - CloudWatch Logs Test Data Writer"
    print_message "$BLUE" "==================================================="
    echo

    check_requirements
    parse_args "$@"
    validate_args
    verify_credentials

    local LOG_GROUP
    local RUN_ID
    local START_MS
    RUN_ID="$(date +%s)-$$"
    find_log_group

    print_message "$BLUE" "Writing ${COUNT} event(s) to the demo log group..."
    write_test_logs

    echo
    if [ "$CHECK" = true ]; then
        check_downstream_chain
    else
        print_message "$GREEN" "Done. Re-run without --no-check to auto-verify the downstream chain,"
        print_message "$GREEN" "or check the log-alert-notifier Lambda's logs manually."
    fi

    echo
    print_message "$GREEN" "==================================================="
    print_message "$GREEN" "  Done."
    print_message "$GREEN" "==================================================="
}

main "$@"
