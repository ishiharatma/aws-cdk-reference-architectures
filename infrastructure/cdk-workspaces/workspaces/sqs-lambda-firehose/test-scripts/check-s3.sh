#!/bin/bash

#######################################
# S3 File Existence Checker - Shell Wrapper
#
# This script provides a convenient wrapper for checking
# if files exist in S3 buckets.
#
# Usage:
#   ./check-s3.sh [OPTIONS]
#
# Examples:
#   ./check-s3.sh --env dev --project myproject --prefix data/2026/01/
#   ./check-s3.sh --bucket my-bucket --prefix data/ --list
#   ./check-s3.sh --bucket my-bucket --key data/file.json
#######################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
PROFILE=""
REGION=""
BUCKET=""
PREFIX=""
KEY=""
PATTERN=""
LIST=false
MAX_KEYS=1000
ENV=""
PROJECT=""

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_SCRIPT="${SCRIPT_DIR}/check-s3-files.py"

#######################################
# Print colored message
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

Check S3 file existence

OPTIONS:
    -h, --help              Show this help message
    -e, --env ENV           Environment (dev, stg, prd)
    -b, --bucket BUCKET     S3 bucket name (required if --env is not specified)
    -p, --prefix PREFIX     S3 prefix (folder path)
    -k, --key KEY           Specific S3 object key to check
    --pattern PATTERN       Pattern to match in file names
    --profile PROFILE       AWS profile name
    --region REGION         AWS region
    -l, --list              List all matching files with details
    --max-keys N            Maximum number of files to list (default: 1000)

EXAMPLES:
    # Check files in dev environment bucket
    $0 --env dev --prefix data/2026/01/

    # Check specific bucket with prefix
    $0 --bucket my-bucket --prefix data/ --list

    # Check specific file
    $0 --bucket my-bucket --key data/file.json

    # Check files with pattern
    $0 --env prd --prefix data/ --pattern ".json"

    # Check with specific profile
    $0 --bucket my-bucket --prefix data/ --profile myprofile

NOTES:
    - Python 3 and boto3 are required
    - AWS credentials must be configured
    - If --env is specified, bucket name will be retrieved from CloudFormation stack outputs

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
# Get bucket name from CloudFormation stack
#######################################
get_bucket_from_env() {
    local env=$1
    local project=$2
    local stack_name="${project}-${env}-sqs-lambda-firehose-stack"
    
    print_message "$BLUE" "Retrieving bucket name from CloudFormation stack: $stack_name"
    
    local aws_cmd="aws cloudformation describe-stacks --stack-name $stack_name --query 'Stacks[0].Outputs[?OutputKey==\`S3BucketName\`].OutputValue' --output text"
    
    if [ -n "$PROFILE" ]; then
        aws_cmd="$aws_cmd --profile $PROFILE"
    fi
    
    if [ -n "$REGION" ]; then
        aws_cmd="$aws_cmd --region $REGION"
    fi
    
    BUCKET=$(eval $aws_cmd 2>/dev/null)
    
    if [ -z "$BUCKET" ]; then
        print_message "$RED" "Error: Could not retrieve bucket name from stack: $stack_name"
        print_message "$YELLOW" "Make sure the stack exists and has BucketName output"
        exit 1
    fi
    
    print_message "$GREEN" "Bucket: $BUCKET"
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
            -b|--bucket)
                BUCKET="$2"
                shift 2
                ;;
            -p|--prefix)
                PREFIX="$2"
                shift 2
                ;;
            -k|--key)
                KEY="$2"
                shift 2
                ;;
            --pattern)
                PATTERN="$2"
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
            -l|--list)
                LIST=true
                shift
                ;;
            --max-keys)
                MAX_KEYS="$2"
                shift 2
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
    # Get bucket from environment if specified
    if [ -n "$ENV" ]; then
        get_bucket_from_env "$ENV" "$PROJECT"
    fi
    
    # Check if bucket is provided
    if [ -z "$BUCKET" ]; then
        print_message "$RED" "Error: Bucket name is required"
        print_message "$YELLOW" "Specify --bucket or --env"
        usage
    fi
}

#######################################
# Build Python command
#######################################
build_python_command() {
    local cmd="python3 $PYTHON_SCRIPT --bucket \"$BUCKET\""
    
    if [ -n "$PREFIX" ]; then
        cmd="$cmd --prefix \"$PREFIX\""
    fi
    
    if [ -n "$KEY" ]; then
        cmd="$cmd --key \"$KEY\""
    fi
    
    if [ -n "$PATTERN" ]; then
        cmd="$cmd --pattern \"$PATTERN\""
    fi
    
    if [ -n "$PROFILE" ]; then
        cmd="$cmd --profile $PROFILE"
    fi
    
    if [ -n "$REGION" ]; then
        cmd="$cmd --region $REGION"
    fi
    
    if [ "$LIST" = true ]; then
        cmd="$cmd --list"
    fi
    
    if [ -n "$MAX_KEYS" ]; then
        cmd="$cmd --max-keys $MAX_KEYS"
    fi
    
    echo "$cmd"
}

#######################################
# Main function
#######################################
main() {
    print_message "$BLUE" "==================================================="
    print_message "$BLUE" "  S3 File Existence Checker"
    print_message "$BLUE" "==================================================="
    echo
    
    # Check requirements
    check_requirements
    
    # Parse arguments
    parse_args "$@"
    
    # Validate arguments
    validate_args
    
    # Build and execute Python command
    cmd=$(build_python_command)
    
    print_message "$GREEN" "Executing: $cmd"
    echo
    
    eval "$cmd"
    
    exit_code=$?
    
    if [ $exit_code -eq 0 ]; then
        echo
        print_message "$GREEN" "==================================================="
        print_message "$GREEN" "  Check completed successfully!"
        print_message "$GREEN" "==================================================="
    else
        echo
        print_message "$RED" "==================================================="
        print_message "$RED" "  Check failed with exit code: $exit_code"
        print_message "$RED" "==================================================="
    fi
    
    exit $exit_code
}

# Run main function
main "$@"
