#!/bin/bash

#######################################
# test-api.sh
#
# Exercises the deployed apigw-s3-stub API: every collection/item method
# (GET/POST /{resource}, GET/PUT/DELETE /{resource}/{item}), the 404 path
# for a missing stub file, the 403 path for a missing/invalid API key, and
# (unless --skip-extend) a live demo of extending the API with zero
# redeploy by dropping a new object straight into the stub bucket.
#
# Stack outputs (ApiUrl, StubBucketName, ApiKeyId) are looked up from the
# ApigwS3StubStack CloudFormation stack outputs, named:
#   <project>-<env>-apigw-s3-stub
# unless --api-url/--api-key-id/--bucket are given explicitly.
#
# Usage:
#   ./test-api.sh --project PROJECT --env ENV [OPTIONS]
#   ./test-api.sh --api-url URL --api-key-id KEY_ID --bucket BUCKET [OPTIONS]
#
# Examples:
#   ./test-api.sh --project myproject --env dev
#   ./test-api.sh --project myproject --env dev --skip-extend
#   ./test-api.sh --project myproject --env dev --keep-extend
#   ./test-api.sh --api-url https://abc123.execute-api.ap-northeast-1.amazonaws.com/dev/ \
#       --api-key-id abc123xyz --bucket myproject-dev-apigw-s3-stub-stubbucket-xxxx
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
API_URL=""
API_KEY_ID=""
STUB_BUCKET=""
SKIP_EXTEND=false
KEEP_EXTEND=false

PASS_COUNT=0
FAIL_COUNT=0

print_message() {
    echo -e "${1}${2}${NC}"
}

usage() {
    cat << EOF
Usage: $0 --project PROJECT --env ENV [OPTIONS]
       $0 --api-url URL --api-key-id KEY_ID --bucket BUCKET [OPTIONS]

Exercise every method of the deployed apigw-s3-stub API (collection and
item GET/POST/PUT/DELETE, the 404 path for a missing stub file, the 403
path for a missing API key), and demo extending the API by dropping a new
object into the stub bucket -- no redeploy required.

OPTIONS:
    -p, --project PROJECT   Project name (required unless --api-url/--api-key-id/--bucket are given)
    -e, --env ENV           Environment name, e.g. dev/stg/prd (required unless --api-url/--api-key-id/--bucket are given)
    --profile PROFILE       AWS CLI profile (default: <project>-<env>)
    --region REGION         AWS region (default: profile's configured region)
    --api-url URL           Base API URL (skips CloudFormation lookup; must end in /)
    --api-key-id KEY_ID     API key ID (skips CloudFormation lookup)
    --bucket BUCKET         Stub bucket name (skips CloudFormation lookup; needed for --skip-extend=false)
    --skip-extend           Skip the "extend the API with a new S3 object" demo
    --keep-extend           Leave the demo "widgets" object in the bucket instead of deleting it afterward
    -h, --help              Show this help message

EXAMPLES:
    # Run every check against a deployed stack
    $0 --project myproject --env dev

    # Skip the live S3-extension demo (e.g. read-only credentials)
    $0 --project myproject --env dev --skip-extend

    # Point directly at a known API/bucket, bypassing CloudFormation lookup
    $0 --api-url https://abc123.execute-api.ap-northeast-1.amazonaws.com/dev/ \\
        --api-key-id abc123xyz --bucket myproject-dev-apigw-s3-stub-stubbucket-xxxx
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
            --api-url)
                API_URL="$2"
                shift 2
                ;;
            --api-key-id)
                API_KEY_ID="$2"
                shift 2
                ;;
            --bucket)
                STUB_BUCKET="$2"
                shift 2
                ;;
            --skip-extend)
                SKIP_EXTEND=true
                shift
                ;;
            --keep-extend)
                KEEP_EXTEND=true
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
    local need_stack_lookup=false
    if [ -z "$API_URL" ] || [ -z "$API_KEY_ID" ]; then
        need_stack_lookup=true
    fi
    if [ "$SKIP_EXTEND" = false ] && [ -z "$STUB_BUCKET" ]; then
        need_stack_lookup=true
    fi

    if [ "$need_stack_lookup" = true ] && { [ -z "$PROJECT" ] || [ -z "$ENVIRONMENT" ]; }; then
        print_message "$RED" "Error: either (--api-url and --api-key-id, plus --bucket unless --skip-extend), or both --project and --env, are required"
        usage
    fi

    if [ -z "$PROFILE" ]; then
        PROFILE="${PROJECT}-${ENVIRONMENT}"
    fi
}

check_requirements() {
    for cmd in aws curl jq; do
        if ! command -v "$cmd" &> /dev/null; then
            print_message "$RED" "Error: ${cmd} is not installed"
            exit 1
        fi
    done
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

# Resolves API_URL / API_KEY_ID / STUB_BUCKET from the ApigwS3StubStack
# CloudFormation stack outputs, for whichever of the three weren't given
# explicitly on the command line.
find_stack_outputs() {
    if [ -n "$API_URL" ] && [ -n "$API_KEY_ID" ] && { [ -n "$STUB_BUCKET" ] || [ "$SKIP_EXTEND" = true ]; }; then
        return
    fi

    local stack_name="${PROJECT}-${ENVIRONMENT}-apigw-s3-stub"
    print_message "$BLUE" "Looking up outputs from CloudFormation stack: ${stack_name}"

    local outputs
    outputs=$(aws_cmd cloudformation describe-stacks \
        --stack-name "$stack_name" \
        --query "Stacks[0].Outputs" \
        --output json)

    if [ -z "$API_URL" ]; then
        API_URL=$(echo "$outputs" | jq -r '.[] | select(.OutputKey=="ApiUrl") | .OutputValue')
    fi
    if [ -z "$API_KEY_ID" ]; then
        API_KEY_ID=$(echo "$outputs" | jq -r '.[] | select(.OutputKey=="ApiKeyId") | .OutputValue')
    fi
    if [ -z "$STUB_BUCKET" ]; then
        STUB_BUCKET=$(echo "$outputs" | jq -r '.[] | select(.OutputKey=="StubBucketName") | .OutputValue')
    fi

    if [ -z "$API_URL" ] || [ "$API_URL" == "null" ]; then
        print_message "$RED" "Error: could not resolve ApiUrl from stack '${stack_name}'"
        print_message "$YELLOW" "Make sure ApigwS3StubStack has been deployed for this project/env, or pass --api-url directly"
        exit 1
    fi
    if [ -z "$API_KEY_ID" ] || [ "$API_KEY_ID" == "null" ]; then
        print_message "$RED" "Error: could not resolve ApiKeyId from stack '${stack_name}'"
        exit 1
    fi

    print_message "$GREEN" "API URL: ${API_URL}"
    print_message "$GREEN" "API Key ID: ${API_KEY_ID}"
    if [ -n "$STUB_BUCKET" ] && [ "$STUB_BUCKET" != "null" ]; then
        print_message "$GREEN" "Stub bucket: ${STUB_BUCKET}"
    fi
}

resolve_api_key_value() {
    print_message "$BLUE" "Fetching API key value..."
    API_KEY_VALUE=$(aws_cmd apigateway get-api-key \
        --api-key "$API_KEY_ID" \
        --include-value \
        --query 'value' \
        --output text)

    if [ -z "$API_KEY_VALUE" ] || [ "$API_KEY_VALUE" == "None" ]; then
        print_message "$RED" "Error: could not fetch the value for API key '${API_KEY_ID}'"
        exit 1
    fi
}

# Runs one HTTP check against $API_URL$path and records PASS/FAIL.
#   check_http <label> <method> <path> <expected_status> [grep_pattern] [--no-key]
# When [grep_pattern] is given, the response body must also match it
# (case-sensitive fixed-string grep) for the check to pass.
# Pass --no-key as the final argument to omit the x-api-key header
# (used for the 403-without-a-key check).
check_http() {
    local label=$1 method=$2 path=$3 expected_status=$4
    shift 4
    local grep_pattern="" use_key=true
    for arg in "$@"; do
        if [ "$arg" == "--no-key" ]; then
            use_key=false
        else
            grep_pattern=$arg
        fi
    done

    local body_file status
    body_file=$(mktemp)
    local curl_args=(-s -o "$body_file" -w "%{http_code}" -X "$method" "${API_URL}${path}")
    if [ "$use_key" = true ]; then
        curl_args+=(-H "x-api-key: ${API_KEY_VALUE}")
    fi

    status=$(curl "${curl_args[@]}")
    local body
    body=$(cat "$body_file")
    rm -f "$body_file"

    if [ "$status" != "$expected_status" ]; then
        print_message "$RED" "  [FAIL] ${label}: expected HTTP ${expected_status}, got ${status}"
        print_message "$RED" "         body: ${body}"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        return
    fi

    if [ -n "$grep_pattern" ] && ! grep -qF "$grep_pattern" <<< "$body"; then
        print_message "$RED" "  [FAIL] ${label}: HTTP ${status} OK, but body did not contain '${grep_pattern}'"
        print_message "$RED" "         body: ${body}"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        return
    fi

    print_message "$GREEN" "  [OK] ${label} (HTTP ${status})"
    PASS_COUNT=$((PASS_COUNT + 1))
}

run_checks() {
    print_message "$BLUE" "Exercising the seeded 'users' resource..."
    check_http "GET /users"            GET    "users"      200 '"Alice"'
    check_http "POST /users"           POST   "users"      200 '"New User"'
    check_http "GET /users/1"          GET    "users/1"    200 '"Alice"'
    check_http "PUT /users/1"          PUT    "users/1"    200 '(updated)'
    check_http "DELETE /users/1"       DELETE "users/1"    200 '"Deleted'

    echo
    print_message "$BLUE" "Checking the 404 path for stub files that don't exist..."
    check_http "GET /users/999 (no such item file)"  GET "users/999"        404
    check_http "GET /no-such-resource"               GET "no-such-resource" 404

    echo
    print_message "$BLUE" "Checking the 403 path for a missing API key..."
    check_http "GET /users without x-api-key" GET "users" 403 --no-key
}

# Demonstrates the core feature of this pattern: dropping a new object into
# the bucket makes it show up at a new API path with zero redeploy.
run_extend_demo() {
    if [ "$SKIP_EXTEND" = true ]; then
        return
    fi
    if [ -z "$STUB_BUCKET" ] || [ "$STUB_BUCKET" == "null" ]; then
        print_message "$YELLOW" "Skipping extend demo: stub bucket name not available (pass --bucket to enable it)"
        return
    fi

    echo
    print_message "$BLUE" "Demo: extending the API with zero redeploy..."
    print_message "$BLUE" "  Uploading widgets/get_result.json to s3://${STUB_BUCKET}/ ..."

    echo '{"id":"42","name":"New Widget (from test-api.sh)"}' \
        | aws_cmd s3 cp - "s3://${STUB_BUCKET}/widgets/get_result.json" --content-type application/json > /dev/null

    check_http "GET /widgets (just added, no redeploy)" GET "widgets" 200 '"New Widget'

    if [ "$KEEP_EXTEND" = true ]; then
        print_message "$YELLOW" "  Leaving widgets/get_result.json in place (--keep-extend)"
    else
        print_message "$BLUE" "  Cleaning up widgets/get_result.json ..."
        aws_cmd s3 rm "s3://${STUB_BUCKET}/widgets/get_result.json" > /dev/null
    fi
}

main() {
    print_message "$BLUE" "==================================================="
    print_message "$BLUE" "  apigw-s3-stub - API Test Runner"
    print_message "$BLUE" "==================================================="
    echo

    check_requirements
    parse_args "$@"
    validate_args

    if [ -n "$PROJECT" ] && [ -n "$ENVIRONMENT" ]; then
        verify_credentials
    fi
    find_stack_outputs
    resolve_api_key_value

    echo
    run_checks
    run_extend_demo

    echo
    print_message "$BLUE" "==================================================="
    if [ "$FAIL_COUNT" -eq 0 ]; then
        print_message "$GREEN" "  Done: ${PASS_COUNT} passed, ${FAIL_COUNT} failed."
    else
        print_message "$RED" "  Done: ${PASS_COUNT} passed, ${FAIL_COUNT} failed."
    fi
    print_message "$BLUE" "==================================================="

    [ "$FAIL_COUNT" -eq 0 ]
}

main "$@"
