#!/bin/bash
#######################################
# test-inference.sh
#
# Operational check for the Lambda Managed Instances GPU pattern.
#
# 1. Shows the capacity provider, the GPU function configuration and the
#    G-series EC2 instances Lambda launched for it.
# 2. Uploads test images under input/<run-id>/ in the image bucket.
# 3. Waits until S3 -> SQS -> GPU function has written a result for every
#    image to DynamoDB, then prints the top label, the GPU that ran the
#    batch and the batch inference time.
# 4. Confirms the dead-letter queue is empty.
#
# `cdk deploy` alone does not prove the GPU path works: the function can be
# Active while the event source mapping, the VPC endpoints or the GPU itself
# are not. This script exercises the whole path.
#
# Requires: aws CLI, jq, curl (only when no --image is given).
#
# Usage:
#   ./test-inference.sh --project PROJECT --env ENV [OPTIONS]
#
# Examples:
#   ./test-inference.sh --project myproject --env dev
#   ./test-inference.sh --project myproject --env dev --count 32 --cleanup
#   ./test-inference.sh --project myproject --env dev --image ./cat.jpg --image ./car.png
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
COUNT=8
TIMEOUT=900
INTERVAL=10
CLEANUP=false
IMAGES=()
SAMPLE_IMAGE_URL="https://github.com/pytorch/hub/raw/master/images/dog.jpg"
RUN_ID="run-$(date +%Y%m%d%H%M%S)"
WORK_DIR=""

print_message() {
    echo -e "${1}${2}${NC}"
}

usage() {
    cat << EOF
Usage: $0 --project PROJECT --env ENV [OPTIONS]

Upload test images to the image bucket, wait for the GPU function to classify
them, and print the results written to DynamoDB.

OPTIONS:
    -p, --project PROJECT     Project name (required)
    -e, --env ENV             Environment name, e.g. dev (required)
    --profile PROFILE         AWS CLI profile (default: <project>-<env>)
    --region REGION           Region of the stack (default: ap-northeast-1)
    --image PATH              Local image to upload (repeatable). Default: a sample dog photo
    --count N                 Number of objects to upload; images are reused round-robin (default: 8)
    --timeout SECONDS         Max seconds to wait for all results (default: 900; scale-from-zero takes minutes)
    --interval SECONDS        Polling interval (default: 10)
    --cleanup                 Delete the uploaded objects afterwards
    -h, --help                Show this help message

EXAMPLES:
    $0 --project myproject --env dev
    $0 --project myproject --env dev --count 32 --cleanup
EOF
    exit 1
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help) usage ;;
            -p|--project) PROJECT="$2"; shift 2 ;;
            -e|--env) ENVIRONMENT="$2"; shift 2 ;;
            --profile) PROFILE="$2"; shift 2 ;;
            --region) REGION="$2"; shift 2 ;;
            --image) IMAGES+=("$2"); shift 2 ;;
            --count) COUNT="$2"; shift 2 ;;
            --timeout) TIMEOUT="$2"; shift 2 ;;
            --interval) INTERVAL="$2"; shift 2 ;;
            --cleanup) CLEANUP=true; shift ;;
            *) print_message "$RED" "Unknown option: $1"; usage ;;
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
        print_message "$RED" "Error: --count must be a positive integer"
        exit 1
    fi
    for image in "${IMAGES[@]+"${IMAGES[@]}"}"; do
        if [ ! -f "$image" ]; then
            print_message "$RED" "Error: image not found: ${image}"
            exit 1
        fi
    done
    STACK_NAME="${PROJECT}-${ENVIRONMENT}-lambda-managed-instances-gpu"
}

check_requirements() {
    local cmds=(aws jq)
    if [ ${#IMAGES[@]} -eq 0 ]; then
        cmds+=(curl)
    fi
    for cmd in "${cmds[@]}"; do
        if ! command -v "$cmd" &> /dev/null; then
            print_message "$RED" "Error: ${cmd} is not installed"
            exit 1
        fi
    done
}

# Wraps `aws` with the resolved --profile and --region.
aws_cmd() {
    aws "$@" --region "$REGION" --profile "$PROFILE"
}

verify_credentials() {
    print_message "$BLUE" "Verifying AWS credentials (profile: ${PROFILE})..."
    if ! aws_cmd sts get-caller-identity > /dev/null; then
        print_message "$RED" "Error: could not authenticate with profile '${PROFILE}'"
        exit 1
    fi
}

stack_output() {
    aws_cmd cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

load_outputs() {
    print_message "$BLUE" "Reading outputs of ${STACK_NAME}..."
    BUCKET=$(stack_output BucketName)
    INPUT_PREFIX=$(stack_output InputPrefix)
    TABLE=$(stack_output ResultTableName)
    DLQ_URL=$(stack_output DeadLetterQueueUrl)
    FUNCTION=$(stack_output FunctionName)
    CAPACITY_PROVIDER=$(stack_output CapacityProviderName)
    if [ -z "$BUCKET" ] || [ "$BUCKET" = "None" ]; then
        print_message "$RED" "Error: stack ${STACK_NAME} not found or has no outputs"
        exit 1
    fi
}

show_configuration() {
    print_message "$BLUE" "\n=== Capacity provider: ${CAPACITY_PROVIDER} ==="
    aws_cmd lambda get-capacity-provider --capacity-provider-name "$CAPACITY_PROVIDER" \
        --query 'CapacityProvider.{State:State,InstanceRequirements:InstanceRequirements,Scaling:CapacityProviderScalingConfig}' \
        --output json || print_message "$YELLOW" "(get-capacity-provider unavailable in this CLI version)"

    print_message "$BLUE" "\n=== Function: ${FUNCTION} ==="
    aws_cmd lambda get-function-configuration --function-name "$FUNCTION" \
        --query '{State:State,LastUpdateStatus:LastUpdateStatus,MemorySize:MemorySize,AcceleratorConfig:AcceleratorConfig,CapacityProviderConfig:CapacityProviderConfig}' \
        --output json
    aws_cmd lambda get-function-scaling-config --function-name "$FUNCTION" --qualifier '$LATEST.PUBLISHED' \
        --output json 2>/dev/null || true

    print_message "$BLUE" "\n=== GPU instances launched by Lambda ==="
    aws_cmd ec2 describe-instances \
        --filters "Name=tag:Project,Values=${PROJECT}" "Name=tag:Environment,Values=${ENVIRONMENT}" \
                  "Name=instance-state-name,Values=pending,running" \
        --query 'Reservations[].Instances[].[InstanceId,InstanceType,Placement.AvailabilityZone,State.Name,LaunchTime]' \
        --output table
}

prepare_images() {
    WORK_DIR=$(mktemp -d)
    if [ ${#IMAGES[@]} -eq 0 ]; then
        print_message "$BLUE" "\nDownloading sample image: ${SAMPLE_IMAGE_URL}"
        curl -fsSL -o "${WORK_DIR}/dog.jpg" "$SAMPLE_IMAGE_URL"
        IMAGES=("${WORK_DIR}/dog.jpg")
    fi
}

upload_images() {
    KEYS=()
    print_message "$BLUE" "\nUploading ${COUNT} object(s) to s3://${BUCKET}/${INPUT_PREFIX}${RUN_ID}/"
    for ((i = 0; i < COUNT; i++)); do
        local src="${IMAGES[$((i % ${#IMAGES[@]}))]}"
        local name
        name=$(basename "$src")
        local key="${INPUT_PREFIX}${RUN_ID}/$(printf '%03d' "$i")-${name}"
        aws_cmd s3 cp "$src" "s3://${BUCKET}/${key}" --only-show-errors
        KEYS+=("$key")
    done
    UPLOADED_AT=$(date +%s)
}

wait_for_results() {
    print_message "$BLUE" "\nWaiting for ${#KEYS[@]} result(s) in ${TABLE} (timeout ${TIMEOUT}s)..."
    local deadline=$((UPLOADED_AT + TIMEOUT))
    local pending=("${KEYS[@]}")
    RESULTS=()
    while [ ${#pending[@]} -gt 0 ]; do
        local still=()
        for key in "${pending[@]}"; do
            local item
            item=$(aws_cmd dynamodb get-item --table-name "$TABLE" \
                --key "{\"objectKey\":{\"S\":\"${key}\"}}" --output json)
            if [ -n "$item" ] && [ "$(echo "$item" | jq 'has("Item")')" = "true" ]; then
                RESULTS+=("$item")
            else
                still+=("$key")
            fi
        done
        pending=("${still[@]+"${still[@]}"}")
        local now
        now=$(date +%s)
        print_message "$NC" "  $((now - UPLOADED_AT))s: $(( ${#KEYS[@]} - ${#pending[@]} ))/${#KEYS[@]} done"
        if [ ${#pending[@]} -eq 0 ]; then
            break
        fi
        if [ "$now" -ge "$deadline" ]; then
            print_message "$RED" "Timed out; ${#pending[@]} image(s) without a result."
            return 1
        fi
        sleep "$INTERVAL"
    done
    ELAPSED=$(( $(date +%s) - UPLOADED_AT ))
}

print_results() {
    print_message "$BLUE" "\n=== Results (upload -> all results: ${ELAPSED}s) ==="
    printf '%s\n' "${RESULTS[@]}" | jq -r -s '
        (["objectKey","top1","score","gpuName","batch","batchMs","workerPid"] | @tsv),
        (.[] | .Item | [
            (.objectKey.S | split("/") | last),
            .labels.L[0].M.label.S,
            .labels.L[0].M.score.N,
            .gpuName.S,
            .batchSize.N,
            .batchInferenceMs.N,
            .workerPid.N
        ] | @tsv)' | column -t -s $'\t'

    local devices
    devices=$(printf '%s\n' "${RESULTS[@]}" | jq -r -s '[.[].Item.device.S] | unique | join(",")')
    if [ "$devices" = "cuda" ]; then
        print_message "$GREEN" "\nAll images were classified on the GPU."
    else
        print_message "$RED" "\nUnexpected device(s): ${devices} (expected cuda)"
        return 1
    fi
}

check_dlq() {
    local count
    count=$(aws_cmd sqs get-queue-attributes --queue-url "$DLQ_URL" \
        --attribute-names ApproximateNumberOfMessages --query 'Attributes.ApproximateNumberOfMessages' --output text)
    if [ "$count" = "0" ]; then
        print_message "$GREEN" "Dead-letter queue is empty."
    else
        print_message "$YELLOW" "Dead-letter queue has ${count} message(s); check the function logs."
    fi
}

cleanup() {
    if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
        rm -rf "$WORK_DIR"
    fi
    if [ "$CLEANUP" = true ] && [ -n "${BUCKET:-}" ]; then
        print_message "$BLUE" "Deleting s3://${BUCKET}/${INPUT_PREFIX}${RUN_ID}/"
        aws_cmd s3 rm "s3://${BUCKET}/${INPUT_PREFIX}${RUN_ID}/" --recursive --only-show-errors || true
    fi
}

main() {
    parse_args "$@"
    validate_args
    check_requirements
    verify_credentials
    trap cleanup EXIT
    load_outputs
    show_configuration
    prepare_images
    upload_images
    local status=0
    wait_for_results || status=1
    if [ ${#RESULTS[@]} -gt 0 ]; then
        print_results || status=1
    fi
    check_dlq
    exit $status
}

main "$@"
