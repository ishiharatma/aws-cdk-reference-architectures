#!/bin/bash

#######################################
# write-test-logs-export.sh
#
# Writes test log events into the CloudWatch Log Group created by
# CloudwatchLogsS3ArchiveExportStack (Stack 4), so there is source data
# for the scheduled CreateExportTask Lambda to export to S3.
#
# Unlike Stacks 1/2 (Firehose), this stack does not stream events in
# near-real-time: the log group is just the export source, and the
# EventBridge-scheduled Lambda (or a manual invoke) picks up whatever
# was written since the last export.
#
# The log group is discovered by prefix:
#   /<project>/<env>/export-
# (CloudwatchLogsS3ArchiveExportStack creates a single log group named
#  /<project>/<env>/export-<suffix>)
#
# Usage:
#   ./write-test-logs-export.sh --project PROJECT --env ENV [OPTIONS]
#
# Examples:
#   ./write-test-logs-export.sh --project myproject --env dev
#   ./write-test-logs-export.sh --project myproject --env dev --count 20 --message "load test"
#   ./write-test-logs-export.sh --project myproject --env dev --invoke
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
INVOKE=false

print_message() {
    echo -e "${1}${2}${NC}"
}

usage() {
    cat << EOF
Usage: $0 --project PROJECT --env ENV [OPTIONS]

Write test log events to the CloudWatch Log Group created by
CloudwatchLogsS3ArchiveExportStack (/<project>/<env>/export-*).

OPTIONS:
    -p, --project PROJECT   Project name (required)
    -e, --env ENV           Environment name, e.g. dev/stg/prd (required)
    --profile PROFILE       AWS CLI profile (default: <project>-<env>)
    --region REGION         AWS region (default: profile's configured region)
    -c, --count N           Number of log events to write to the log group (default: 1)
    -m, --message MESSAGE   Log message body (default: "hello export-task from <log-group>")
    -i, --invoke            Manually invoke the export Lambda after writing test data
    -h, --help              Show this help message

EXAMPLES:
    # Write 1 test event to the export-stack log group
    $0 --project myproject --env dev

    # Write 20 events, then immediately trigger the export Lambda
    $0 --project myproject --env dev --count 20 --invoke

NOTES:
    - CreateExportTask only exports events already written when the task starts,
      and the scheduled Lambda targets the *previous* day's logs by default. Use
      --invoke to run the Lambda immediately instead of waiting for the schedule
      (the Lambda's own export-window logic still applies).
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
            -i|--invoke)
                INVOKE=true
                shift
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

# Populates the LOG_GROUPS array with log groups under /<project>/<env>/export-
find_log_groups() {
    local prefix="/${PROJECT}/${ENVIRONMENT}/export-"

    print_message "$BLUE" "Looking up log groups with prefix: ${prefix}"

    mapfile -t LOG_GROUPS < <(
        aws_cmd logs describe-log-groups \
            --log-group-name-prefix "$prefix" \
            --query 'logGroups[].logGroupName' \
            --output text | tr '\t' '\n'
    )

    if [ "${#LOG_GROUPS[@]}" -eq 0 ] || [ -z "${LOG_GROUPS[0]}" ]; then
        print_message "$RED" "Error: no log groups found with prefix '${prefix}'"
        print_message "$YELLOW" "Make sure CloudwatchLogsS3ArchiveExportStack has been deployed for this project/env"
        exit 1
    fi

    print_message "$GREEN" "Found ${#LOG_GROUPS[@]} log group(s)"
}

# Writes $COUNT log events to a single log group
write_test_logs_to_group() {
    local log_group=$1
    local log_stream="test-stream-$(date +%Y%m%d%H%M%S)"
    local message="${MESSAGE:-hello export-task from ${log_group}}"

    print_message "$BLUE" "  -> ${log_group} (stream: ${log_stream})"

    aws_cmd logs create-log-stream \
        --log-group-name "$log_group" \
        --log-stream-name "$log_stream"

    local now_ms
    now_ms=$(($(date +%s%N) / 1000000))

    local events_json
    events_json=$(jq -n --argjson count "$COUNT" --argjson start "$now_ms" --arg msg "$message" '
        [range($count) | {timestamp: ($start + .), message: "\($msg) #\(. + 1)"}]
    ')

    aws_cmd logs put-log-events \
        --log-group-name "$log_group" \
        --log-stream-name "$log_stream" \
        --log-events "$events_json" > /dev/null
}

invoke_export_function() {
    local function_name="${PROJECT}-${ENVIRONMENT}-cwl-export-task"

    print_message "$BLUE" "Invoking export Lambda: ${function_name}"

    local response_file
    response_file=$(mktemp)

    aws_cmd lambda invoke \
        --function-name "$function_name" \
        --payload '{}' \
        --cli-binary-format raw-in-base64-out \
        "$response_file" > /dev/null

    print_message "$GREEN" "Lambda response:"
    cat "$response_file"
    echo
    rm -f "$response_file"
}

main() {
    print_message "$BLUE" "==================================================="
    print_message "$BLUE" "  CloudWatch Logs Test Data Writer (Export Stack)"
    print_message "$BLUE" "==================================================="
    echo

    check_requirements
    parse_args "$@"
    validate_args
    verify_credentials

    local -a LOG_GROUPS
    find_log_groups

    print_message "$BLUE" "Writing ${COUNT} event(s) to each log group..."
    for log_group in "${LOG_GROUPS[@]}"; do
        write_test_logs_to_group "$log_group"
    done

    if [ "$INVOKE" = true ]; then
        echo
        invoke_export_function
    fi

    echo
    print_message "$GREEN" "==================================================="
    if [ "$INVOKE" = true ]; then
        print_message "$GREEN" "  Done. Check the archive bucket for the export output."
    else
        print_message "$GREEN" "  Done. The export Lambda runs on its EventBridge schedule;"
        print_message "$GREEN" "  pass --invoke to trigger it immediately instead."
    fi
    print_message "$GREEN" "==================================================="
}

main "$@"
