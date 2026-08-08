#!/bin/bash

#######################################
# publish-sns-message.sh
#
# Publishes test messages to the MainTopic created by SnsBasicStack, to
# exercise every subscription at once:
#   Email, SQS -> sqs-message-logger, Lambda -> sns-message-logger,
#   HTTPS -> API Gateway -> sns-http-endpoint -> S3 + DynamoDB,
#   Amazon Data Firehose -> S3
#
# The topic ARN is looked up from the SnsBasicStack CloudFormation stack
# outputs (MainTopicArn), named:
#   <project>-<env>-sns-basic
# unless --topic-arn is given explicitly.
#
# By default, after publishing, this script also polls every subscriber to
# confirm the message was actually processed on each path:
#   - sqs-message-logger's and sns-message-logger's own CloudWatch Logs
#   - the sns-http-endpoint Lambda's logs, plus the S3 object and DynamoDB
#     item it should have written (looked up by this run's SNS MessageId)
#   - the Firehose archive bucket for a newly-arrived object (best-effort;
#     Firehose buffers before flushing, so this can take longer)
# Use --no-check to skip this and only publish.
#
# Checking requires --project/--env (to resolve the stack's other outputs
# and function names) even if --topic-arn was used to skip the topic lookup.
#
# Usage:
#   ./publish-sns-message.sh --project PROJECT --env ENV [OPTIONS]
#   ./publish-sns-message.sh --topic-arn ARN [OPTIONS]
#
# Examples:
#   ./publish-sns-message.sh --project myproject --env dev
#   ./publish-sns-message.sh --project myproject --env dev --count 5 --message "load test"
#   ./publish-sns-message.sh --project myproject --env dev --no-check
#   ./publish-sns-message.sh --topic-arn arn:aws:sns:ap-northeast-1:111111111111:myproject-dev-sns-basic-main --subject "manual test"
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
TOPIC_ARN=""
COUNT=1
SUBJECT="sns-basic test notification"
MESSAGE=""
CHECK=true
TIMEOUT=90
INTERVAL=5

print_message() {
    echo -e "${1}${2}${NC}"
}

usage() {
    cat << EOF
Usage: $0 --project PROJECT --env ENV [OPTIONS]
       $0 --topic-arn ARN [OPTIONS]

Publish test messages to the MainTopic created by SnsBasicStack, fanning
out to every subscription (Email, SQS, Lambda, HTTPS/API Gateway, Firehose)
at once.

OPTIONS:
    -p, --project PROJECT   Project name (required unless --topic-arn is given)
    -e, --env ENV           Environment name, e.g. dev/stg/prd (required unless --topic-arn is given)
    -t, --topic-arn ARN     MainTopic ARN (skips CloudFormation lookup)
    --profile PROFILE       AWS CLI profile (default: <project>-<env>)
    --region REGION         AWS region (default: profile's configured region)
    -c, --count N           Number of messages to publish (default: 1)
    -s, --subject SUBJECT   SNS Subject (default: "sns-basic test notification")
    -m, --message MESSAGE   Message body (default: a small JSON payload with a sequence number)
    --no-check              Only publish; skip polling every subscriber for confirmation
    --timeout N             Max seconds to poll for downstream confirmation (default: 90)
    --interval N            Seconds between polling attempts (default: 5)
    -h, --help              Show this help message

EXAMPLES:
    # Publish 1 test message and confirm every subscriber processed it
    $0 --project myproject --env dev

    # Publish 5 messages with a custom message body
    $0 --project myproject --env dev --count 5 --message "load test"

    # Just publish, don't wait around for confirmation
    $0 --project myproject --env dev --no-check

    # Publish directly to a known topic ARN (checking still needs --project/--env)
    $0 --topic-arn arn:aws:sns:ap-northeast-1:111111111111:myproject-dev-sns-basic-main --project myproject --env dev
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
            -t|--topic-arn)
                TOPIC_ARN="$2"
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
            -s|--subject)
                SUBJECT="$2"
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
    if [ -z "$TOPIC_ARN" ] && { [ -z "$PROJECT" ] || [ -z "$ENVIRONMENT" ]; }; then
        print_message "$RED" "Error: either --topic-arn, or both --project and --env, are required"
        usage
    fi

    if [ -z "$PROFILE" ]; then
        PROFILE="${PROJECT}-${ENVIRONMENT}"
    fi

    if ! [[ "$COUNT" =~ ^[0-9]+$ ]] || [ "$COUNT" -lt 1 ]; then
        print_message "$RED" "Error: count must be a positive integer"
        exit 1
    fi

    if [ "$CHECK" = true ] && { [ -z "$PROJECT" ] || [ -z "$ENVIRONMENT" ]; }; then
        print_message "$RED" "Error: --project and --env are required to check downstream processing"
        print_message "$YELLOW" "(pass --no-check to skip verification and only publish)"
        usage
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

    if [ "$CHECK" = true ] && ! command -v jq &> /dev/null; then
        print_message "$RED" "Error: jq is not installed (required for --check; pass --no-check to skip it)"
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

# Resolves TOPIC_ARN from the SnsBasicStack CloudFormation stack outputs
find_topic_arn() {
    if [ -n "$TOPIC_ARN" ]; then
        return
    fi

    local stack_name="${PROJECT}-${ENVIRONMENT}-sns-basic"
    print_message "$BLUE" "Looking up MainTopicArn from CloudFormation stack: ${stack_name}"

    TOPIC_ARN=$(aws_cmd cloudformation describe-stacks \
        --stack-name "$stack_name" \
        --query "Stacks[0].Outputs[?OutputKey=='MainTopicArn'].OutputValue" \
        --output text)

    if [ -z "$TOPIC_ARN" ] || [ "$TOPIC_ARN" == "None" ]; then
        print_message "$RED" "Error: could not resolve MainTopicArn from stack '${stack_name}'"
        print_message "$YELLOW" "Make sure SnsBasicStack has been deployed for this project/env, or pass --topic-arn directly"
        exit 1
    fi

    print_message "$GREEN" "Topic ARN: ${TOPIC_ARN}"
}

# Publishes $COUNT messages to TOPIC_ARN.
# Every message is tagged with $RUN_ID so downstream logs can be matched
# back to this specific run (see check_downstream_processing). The SNS
# MessageId of the *last* published message is kept in LAST_MESSAGE_ID,
# since that is what sns-http-endpoint uses as its S3 key / DynamoDB
# partition key.
publish_messages() {
    for i in $(seq 1 "$COUNT"); do
        local body="${MESSAGE:-"{\"source\":\"publish-sns-message.sh\",\"sequence\":${i}}"}"
        body="${body} [run:${RUN_ID}]"

        print_message "$BLUE" "  -> publishing message ${i}/${COUNT}"

        LAST_MESSAGE_ID=$(aws_cmd sns publish \
            --topic-arn "$TOPIC_ARN" \
            --subject "$SUBJECT" \
            --message "$body" \
            --query 'MessageId' \
            --output text)

        print_message "$GREEN" "     MessageId: ${LAST_MESSAGE_ID}"
    done
}

# Resolves the CloudWatch Log Group actually attached to a Lambda function
# (works whether the function uses its default log group or a custom one).
# Prints a warning immediately (to stderr) if this fails, instead of
# silently swallowing it -- an unresolved log group means the check for
# that function can never succeed, and that's worth surfacing right away
# rather than only as a generic timeout 90 seconds later.
resolve_function_log_group() {
    local function_name=$1
    local log_group
    local err
    err=$(mktemp)
    log_group=$(aws_cmd lambda get-function-configuration \
        --function-name "$function_name" \
        --query 'LoggingConfig.LogGroup' \
        --output text 2>"$err") || {
        print_message "$RED" "  Warning: could not look up function '${function_name}':"
        sed 's/^/    /' "$err" >&2
        rm -f "$err"
        return 0
    }
    rm -f "$err"

    if [ -z "$log_group" ] || [ "$log_group" == "None" ]; then
        print_message "$YELLOW" "  Warning: function '${function_name}' has no LoggingConfig.LogGroup"
        print_message "$YELLOW" "  (its own log group could not be resolved -- checking it will be skipped)"
        return 0
    fi

    echo "$log_group"
}

# Returns 0 (true) if $log_group has a line matching $pattern timestamped
# at or after $START_MS, without waiting -- used inside the combined
# polling loop in check_downstream_processing.
log_group_has_match() {
    local log_group=$1
    local pattern=$2
    local matches
    matches=$(aws_cmd logs filter-log-events \
        --log-group-name "$log_group" \
        --start-time "$START_MS" \
        --filter-pattern "$pattern" \
        --query 'events[].message' \
        --output text 2>/dev/null || true)
    [ -n "$matches" ]
}

# Prints whatever this log group actually logged since $START_MS,
# ignoring the filter pattern -- used on timeout to tell "the function was
# never invoked" apart from "it was invoked but didn't log what we expected".
dump_recent_log_events() {
    local log_group=$1
    local label=$2
    local events

    events=$(aws_cmd logs filter-log-events \
        --log-group-name "$log_group" \
        --start-time "$START_MS" \
        --query 'events[].message' \
        --output text 2>/dev/null || true)

    if [ -z "$events" ]; then
        print_message "$RED" "  [DEBUG] ${label}: log group '${log_group}' has NO events at all since this run started."
        print_message "$RED" "          This points at the function never being invoked (check the SNS"
        print_message "$RED" "          subscription / event source mapping), not a text-matching problem."
    else
        print_message "$YELLOW" "  [DEBUG] ${label}: log group '${log_group}' DID log something, but not a match:"
        echo "$events" | tr '\t' '\n' | sed 's/^/        /'
    fi
}

# Returns 0 (true) if the given S3 object exists.
s3_object_exists() {
    local bucket=$1
    local key=$2
    aws_cmd s3api head-object --bucket "$bucket" --key "$key" > /dev/null 2>&1
}

# Returns 0 (true) if a DynamoDB item with the given messageId partition key exists.
ddb_item_exists() {
    local table=$1
    local message_id=$2
    local item
    item=$(aws_cmd dynamodb get-item \
        --table-name "$table" \
        --key "{\"messageId\":{\"S\":\"${message_id}\"}}" \
        --query 'Item' \
        --output text 2>/dev/null || true)
    [ -n "$item" ] && [ "$item" != "None" ]
}

# Returns 0 (true) if $bucket has any object modified at or after $START_ISO.
s3_has_new_object() {
    local bucket=$1
    local count
    count=$(aws_cmd s3api list-objects-v2 \
        --bucket "$bucket" \
        --query "length(Contents[?LastModified >= '${START_ISO}'])" \
        --output text 2>/dev/null || echo 0)
    [ "$count" != "0" ] && [ "$count" != "None" ]
}

# Resolves the stack's other outputs/resource names needed for checking,
# and polls every subscriber path until all are confirmed or $TIMEOUT
# elapses.
check_downstream_processing() {
    print_message "$BLUE" "Waiting for every subscriber to process the last published message..."
    print_message "$BLUE" "(polling every ${INTERVAL}s, up to ${TIMEOUT}s)"
    echo

    local stack_name="${PROJECT}-${ENVIRONMENT}-sns-basic"
    local payload_bucket payload_table firehose_bucket
    payload_bucket=$(aws_cmd cloudformation describe-stacks --stack-name "$stack_name" \
        --query "Stacks[0].Outputs[?OutputKey=='PayloadBucketName'].OutputValue" --output text)
    payload_table=$(aws_cmd cloudformation describe-stacks --stack-name "$stack_name" \
        --query "Stacks[0].Outputs[?OutputKey=='PayloadTableName'].OutputValue" --output text)
    firehose_bucket=$(aws_cmd cloudformation describe-stacks --stack-name "$stack_name" \
        --query "Stacks[0].Outputs[?OutputKey=='FirehoseArchiveBucketName'].OutputValue" --output text)

    local sqs_log_group sns_log_group http_log_group
    sqs_log_group=$(resolve_function_log_group "${PROJECT}-${ENVIRONMENT}-sqs-message-logger")
    sns_log_group=$(resolve_function_log_group "${PROJECT}-${ENVIRONMENT}-sns-message-logger")
    http_log_group=$(resolve_function_log_group "${PROJECT}-${ENVIRONMENT}-sns-http-endpoint")

    print_message "$BLUE" "  sqs-message-logger log group:  ${sqs_log_group:-<unresolved>}"
    print_message "$BLUE" "  sns-message-logger log group:  ${sns_log_group:-<unresolved>}"
    print_message "$BLUE" "  sns-http-endpoint log group:   ${http_log_group:-<unresolved>}"
    echo

    # label -> done flag
    local -A done_flags=(
        [sqs-message-logger]=false
        [sns-message-logger]=false
        [sns-http-endpoint-logs]=false
        [payload-s3]=false
        [payload-dynamodb]=false
        [firehose-s3]=false
    )

    local elapsed=0
    while [ "$elapsed" -lt "$TIMEOUT" ]; do
        if [ "${done_flags[sqs-message-logger]}" = false ] && [ -n "$sqs_log_group" ] && [ "$sqs_log_group" != "None" ]; then
            log_group_has_match "$sqs_log_group" "\"run:${RUN_ID}\"" && done_flags[sqs-message-logger]=true \
                && print_message "$GREEN" "  [OK] sqs-message-logger processed the message (SNS -> SQS -> Lambda)"
        fi

        if [ "${done_flags[sns-message-logger]}" = false ] && [ -n "$sns_log_group" ] && [ "$sns_log_group" != "None" ]; then
            log_group_has_match "$sns_log_group" "\"${LAST_MESSAGE_ID}\"" && done_flags[sns-message-logger]=true \
                && print_message "$GREEN" "  [OK] sns-message-logger processed the message (SNS -> Lambda)"
        fi

        if [ "${done_flags[sns-http-endpoint-logs]}" = false ] && [ -n "$http_log_group" ] && [ "$http_log_group" != "None" ]; then
            log_group_has_match "$http_log_group" "\"${LAST_MESSAGE_ID}\"" && done_flags[sns-http-endpoint-logs]=true \
                && print_message "$GREEN" "  [OK] sns-http-endpoint received the notification (SNS -> API Gateway -> Lambda)"
        fi

        if [ "${done_flags[payload-s3]}" = false ] && [ -n "$payload_bucket" ] && [ "$payload_bucket" != "None" ]; then
            s3_object_exists "$payload_bucket" "notifications/${LAST_MESSAGE_ID}.json" && done_flags[payload-s3]=true \
                && print_message "$GREEN" "  [OK] notification stored in S3 (s3://${payload_bucket}/notifications/${LAST_MESSAGE_ID}.json)"
        fi

        if [ "${done_flags[payload-dynamodb]}" = false ] && [ -n "$payload_table" ] && [ "$payload_table" != "None" ]; then
            ddb_item_exists "$payload_table" "$LAST_MESSAGE_ID" && done_flags[payload-dynamodb]=true \
                && print_message "$GREEN" "  [OK] notification stored in DynamoDB (table: ${payload_table})"
        fi

        if [ "${done_flags[firehose-s3]}" = false ] && [ -n "$firehose_bucket" ] && [ "$firehose_bucket" != "None" ]; then
            s3_has_new_object "$firehose_bucket" && done_flags[firehose-s3]=true \
                && print_message "$GREEN" "  [OK] Firehose flushed at least one new object to S3 (bucket: ${firehose_bucket})"
        fi

        local all_done=true
        for key in "${!done_flags[@]}"; do
            [ "${done_flags[$key]}" = false ] && all_done=false
        done
        [ "$all_done" = true ] && break

        sleep "$INTERVAL"
        elapsed=$((elapsed + INTERVAL))
        print_message "$YELLOW" "  ... still waiting (${elapsed}s/${TIMEOUT}s)"
    done

    echo
    local any_pending=false
    for key in "${!done_flags[@]}"; do
        if [ "${done_flags[$key]}" = false ]; then
            any_pending=true
            print_message "$RED" "  [TIMEOUT] ${key} not confirmed within ${TIMEOUT}s"
        fi
    done

    # For the three log-based checks specifically, show what (if anything)
    # was actually logged, to tell "never invoked" apart from "invoked but
    # didn't match the expected text".
    if [ "${done_flags[sqs-message-logger]}" = false ] && [ -n "$sqs_log_group" ] && [ "$sqs_log_group" != "None" ]; then
        dump_recent_log_events "$sqs_log_group" "sqs-message-logger"
    fi
    if [ "${done_flags[sns-message-logger]}" = false ] && [ -n "$sns_log_group" ] && [ "$sns_log_group" != "None" ]; then
        dump_recent_log_events "$sns_log_group" "sns-message-logger"
    fi
    if [ "${done_flags[sns-http-endpoint-logs]}" = false ] && [ -n "$http_log_group" ] && [ "$http_log_group" != "None" ]; then
        dump_recent_log_events "$http_log_group" "sns-http-endpoint"
    fi

    if [ "$any_pending" = false ]; then
        print_message "$GREEN" "Confirmed: every subscriber processed the message."
    else
        print_message "$YELLOW" "Some paths were not confirmed within ${TIMEOUT}s -- Firehose in"
        print_message "$YELLOW" "particular buffers before flushing (${INTERVAL}s polling, default"
        print_message "$YELLOW" "buffering window is 60s), so this can just mean it's still in flight."
        print_message "$YELLOW" "Re-run with a longer --timeout, or check manually."
    fi
}

main() {
    print_message "$BLUE" "==================================================="
    print_message "$BLUE" "  SNS Basic - Test Message Publisher"
    print_message "$BLUE" "==================================================="
    echo

    check_requirements
    parse_args "$@"
    validate_args
    verify_credentials
    find_topic_arn

    local RUN_ID LAST_MESSAGE_ID START_MS START_ISO
    RUN_ID="$(date +%s)-$$"
    START_MS=$(($(date +%s%N) / 1000000))
    START_ISO=$(date -u -d "@$((START_MS / 1000))" +"%Y-%m-%dT%H:%M:%S+00:00")

    print_message "$BLUE" "Publishing ${COUNT} message(s) to the main topic..."
    publish_messages

    echo
    if [ "$CHECK" = true ]; then
        check_downstream_processing
    else
        print_message "$GREEN" "Done. Re-run without --no-check to auto-verify every subscriber,"
        print_message "$GREEN" "or check your inbox, the SQS/Lambda consumers, the"
        print_message "$GREEN" "PayloadBucket/PayloadTable, and the Firehose archive bucket manually."
    fi

    echo
    print_message "$GREEN" "==================================================="
    print_message "$GREEN" "  Done."
    print_message "$GREEN" "==================================================="
}

main "$@"
