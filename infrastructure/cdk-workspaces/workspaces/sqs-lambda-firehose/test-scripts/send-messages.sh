#!/bin/bash

#######################################
# SQS Test Message Sender - Shell Wrapper
#
# This script provides a convenient wrapper around the Python script
# for sending test messages to SQS queues.
#
# Usage:
#   ./send-messages.sh [OPTIONS]
#
# Examples:
#   ./send-messages.sh --env dev --project myproject --count 10
#   ./send-messages.sh --queue-url https://sqs.ap-northeast-1.amazonaws.com/123456789012/my-queue --count 50
#   ./send-messages.sh --env prd --fifo --count 20
#######################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
COUNT=10
PROFILE=""
REGION=""
QUEUE_URL=""
QUEUE_URL_FAILURE=""
FIFO=false
MESSAGE_GROUP=""
NO_BATCH=false
ENV=""
PROJECT=""

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_SCRIPT="${SCRIPT_DIR}/send-sqs-messages.py"

#######################################
# Print colored message
# Arguments:
#   $1 - Color
#   $2 - Message
#######################################
print_message() {
    echo -e "${1}${2}${NC}"
}

#######################################
# Print usage information
#######################################
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Send test messages to SQS queue

OPTIONS:
    -h, --help              Show this help message
    -e, --env ENV           Environment (dev, stg, prd)
    -q, --queue-url URL     SQS queue URL (required if --env is not specified)
    -c, --count N           Number of messages to send (default: 10)
    -p, --profile PROFILE   AWS profile name
    -r, --region REGION     AWS region
    -f, --fifo              Queue is FIFO queue
    -g, --message-group ID  Message group ID for FIFO queues
    --no-batch              Disable batch sending

EXAMPLES:
    # Send 10 messages to dev environment queue
    $0 --env dev --count 10

    # Send 50 messages to specific queue with profile
    $0 --queue-url https://sqs.ap-northeast-1.amazonaws.com/123456789012/my-queue --count 50 --profile myprofile

    # Send messages to FIFO queue
    $0 --env prd --fifo --count 20 --message-group my-group

NOTES:
    - Python 3 and boto3 are required
    - AWS credentials must be configured
    - If --env is specified, queue URL will be retrieved from CloudFormation stack outputs

EOF
    exit 1
}

#######################################
# Check if required commands exist
#######################################
check_requirements() {
    if ! command -v python3 &> /dev/null; then
        print_message "$RED" "Error: python3 is not installed"
        exit 1
    fi

    if ! python3 -c "import boto3" 2>/dev/null; then
        print_message "$YELLOW" "Warning: boto3 is not installed"
        print_message "$YELLOW" "Installing boto3..."
        pip3 install boto3
    fi

    if [ ! -f "$PYTHON_SCRIPT" ]; then
        print_message "$RED" "Error: Python script not found: $PYTHON_SCRIPT"
        exit 1
    fi
}

#######################################
# Get queue URL from CloudFormation stack
# Arguments:
#   $1 - Environment (dev, stg, prd)
#   $2 - Project name
#######################################
get_queue_url_from_env() {
    local env=$1
    local project=$2
    local stack_name="${project}-${env}-sqs-lambda-firehose-stack"

    print_message "$BLUE" "Retrieving queue URL from CloudFormation stack: $stack_name"
    
    local aws_cmd="aws cloudformation describe-stacks --stack-name $stack_name --query 'Stacks[0].Outputs[?OutputKey==\`SqsQueueUrl\`].OutputValue' --output text"
    
    if [ -n "$PROFILE" ]; then
        aws_cmd="$aws_cmd --profile $PROFILE"
    fi
    
    if [ -n "$REGION" ]; then
        aws_cmd="$aws_cmd --region $REGION"
    fi
    
    QUEUE_URL=$(eval $aws_cmd 2>/dev/null)
    
    if [ -z "$QUEUE_URL" ]; then
        print_message "$RED" "Error: Could not retrieve queue URL from stack: $stack_name"
        print_message "$YELLOW" "Make sure the stack exists and has QueueUrl output"
        exit 1
    fi
    
    print_message "$GREEN" "Queue URL: $QUEUE_URL"

    local aws_cmd_failure="aws cloudformation describe-stacks --stack-name $stack_name --query 'Stacks[0].Outputs[?OutputKey==\`SqsQueueFailureUrl\`].OutputValue' --output text"
    
    if [ -n "$PROFILE" ]; then
        aws_cmd_failure="$aws_cmd_failure --profile $PROFILE"
    fi
    
    if [ -n "$REGION" ]; then
        aws_cmd_failure="$aws_cmd_failure --region $REGION"
    fi
    QUEUE_URL_FAILURE=$(eval $aws_cmd_failure 2>/dev/null)
    
    if [ -z "$QUEUE_URL_FAILURE" ]; then
        print_message "$RED" "Error: Could not retrieve failure queue URL from stack: $stack_name"
        print_message "$YELLOW" "Make sure the stack exists and has SqsQueueFailureUrl output"
        exit 1
    fi
    
    print_message "$GREEN" "Failure Queue URL: $QUEUE_URL_FAILURE"
}

#######################################
# Parse command line arguments
#######################################
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help)
                usage
                ;;
            -e|--env)
                ENV="$2"
                shift 2
                ;;
            --project)
                PROJECT="$2"
                shift 2
                ;;
            -q|--queue-url)
                QUEUE_URL="$2"
                shift 2
                ;;
            -c|--count)
                COUNT="$2"
                shift 2
                ;;
            -p|--profile)
                PROFILE="$2"
                shift 2
                ;;
            -r|--region)
                REGION="$2"
                shift 2
                ;;
            -f|--fifo)
                FIFO=true
                shift
                ;;
            -g|--message-group)
                MESSAGE_GROUP="$2"
                shift 2
                ;;
            --no-batch)
                NO_BATCH=true
                shift
                ;;
            *)
                print_message "$RED" "Unknown option: $1"
                usage
                ;;
        esac
    done
}

#######################################
# Validate arguments
#######################################
validate_args() {
    if [ -z "$PROFILE" ]; then
        PROFILE=$PROJECT-$ENV
    fi

    # Get queue URL from environment if specified
    if [ -n "$ENV" ]; then
        get_queue_url_from_env "$ENV" "${PROJECT}"
    fi
    
    # Check if queue URL is provided
    if [ -z "$QUEUE_URL" ]; then
        print_message "$RED" "Error: Queue URL is required"
        print_message "$YELLOW" "Specify --queue-url or --env"
        usage
    fi
    
    # Validate count
    if ! [[ "$COUNT" =~ ^[0-9]+$ ]] || [ "$COUNT" -lt 1 ]; then
        print_message "$RED" "Error: count must be a positive integer"
        exit 1
    fi
}

#######################################
# Build Python command
#######################################
build_python_command() {
    PARAM_URL=$1
    local cmd="python3 $PYTHON_SCRIPT --queue-url \"$PARAM_URL\" --count $COUNT"
    
    if [ -n "$PROFILE" ]; then
        cmd="$cmd --profile $PROFILE"
    fi
    
    if [ -n "$REGION" ]; then
        cmd="$cmd --region $REGION"
    fi
    
    if [ "$FIFO" = true ]; then
        cmd="$cmd --fifo"
    fi
    
    if [ -n "$MESSAGE_GROUP" ]; then
        cmd="$cmd --message-group \"$MESSAGE_GROUP\""
    fi
    
    if [ "$NO_BATCH" = true ]; then
        cmd="$cmd --no-batch"
    fi
    
    echo "$cmd"
}

#######################################
# Main function
#######################################
main() {
    print_message "$BLUE" "==================================================="
    print_message "$BLUE" "  SQS Test Message Sender"
    print_message "$BLUE" "==================================================="
    echo
    
    # Check requirements
    check_requirements
    
    # Parse arguments
    parse_args "$@"
    
    # Validate arguments
    validate_args
    
    # Build and execute Python command
    cmd=$(build_python_command "$QUEUE_URL")
    
    print_message "$GREEN" "Executing: $cmd"
    echo
    
    eval "$cmd"
    
    exit_code=$?
    
    if [ $exit_code -eq 0 ]; then
        echo
        print_message "$GREEN" "==================================================="
        print_message "$GREEN" "  Successfully completed!"
        print_message "$GREEN" "==================================================="
    else
        echo
        print_message "$RED" "==================================================="
        print_message "$RED" "  Failed with exit code: $exit_code"
        print_message "$RED" "==================================================="
    fi

    cmd=$(build_python_command "$QUEUE_URL_FAILURE")
    
    print_message "$GREEN" "Executing: $cmd"
    echo
    
    eval "$cmd"
    
    exit_code=$?
    
    if [ $exit_code -eq 0 ]; then
        echo
        print_message "$GREEN" "==================================================="
        print_message "$GREEN" "  Successfully completed!"
        print_message "$GREEN" "==================================================="
    else
        echo
        print_message "$RED" "==================================================="
        print_message "$RED" "  Failed with exit code: $exit_code"
        print_message "$RED" "==================================================="
    fi
    
    exit $exit_code
}

# Run main function
main "$@"
