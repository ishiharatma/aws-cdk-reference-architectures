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
# Usage:
#   ./publish-sns-message.sh --project PROJECT --env ENV [OPTIONS]
#   ./publish-sns-message.sh --topic-arn ARN [OPTIONS]
#
# Examples:
#   ./publish-sns-message.sh --project myproject --env dev
#   ./publish-sns-message.sh --project myproject --env dev --count 5 --message "load test"
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
    -h, --help              Show this help message

EXAMPLES:
    # Publish 1 test message, resolving the topic ARN from CloudFormation
    $0 --project myproject --env dev

    # Publish 5 messages with a custom message body
    $0 --project myproject --env dev --count 5 --message "load test"

    # Publish directly to a known topic ARN
    $0 --topic-arn arn:aws:sns:ap-northeast-1:111111111111:myproject-dev-sns-basic-main
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
}

check_requirements() {
    if ! command -v aws &> /dev/null; then
        print_message "$RED" "Error: aws CLI is not installed"
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

# Publishes $COUNT messages to TOPIC_ARN
publish_messages() {
    for i in $(seq 1 "$COUNT"); do
        local body="${MESSAGE:-"{\"source\":\"publish-sns-message.sh\",\"sequence\":${i}}"}"

        print_message "$BLUE" "  -> publishing message ${i}/${COUNT}"

        aws_cmd sns publish \
            --topic-arn "$TOPIC_ARN" \
            --subject "$SUBJECT" \
            --message "$body" \
            --query 'MessageId' \
            --output text
    done
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

    print_message "$BLUE" "Publishing ${COUNT} message(s) to the main topic..."
    publish_messages

    echo
    print_message "$GREEN" "==================================================="
    print_message "$GREEN" "  Done. Check your inbox, the SQS/Lambda consumers,"
    print_message "$GREEN" "  the PayloadBucket/PayloadTable, and the Firehose"
    print_message "$GREEN" "  archive bucket shortly."
    print_message "$GREEN" "==================================================="
}

main "$@"
