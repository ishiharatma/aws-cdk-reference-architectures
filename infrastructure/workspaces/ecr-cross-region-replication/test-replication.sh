#!/bin/bash

#######################################
# test-replication.sh
#
# Pushes a small test image to the source ECR repository in Tokyo
# (ap-northeast-1), waits for ECR Cross-Region Replication to copy it into
# the pre-created destination repository in Osaka (ap-northeast-3), and
# prints both repositories' lifecycle policies side by side to demonstrate
# that they are configured independently.
#
# Requires: aws CLI, docker (to pull/tag/push a test image), jq.
#
# Usage:
#   ./test-replication.sh --project PROJECT --env ENV [OPTIONS]
#
# Examples:
#   ./test-replication.sh --project myproject --env dev
#   ./test-replication.sh --project myproject --env dev --cleanup
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
REPO_SUFFIX="sample-app"
SOURCE_REGION="ap-northeast-1"
DEST_REGION="ap-northeast-3"
TAG="crr-test-$(date +%Y%m%d%H%M%S)"
TIMEOUT=300
INTERVAL=10
CLEANUP=false
SOURCE_TEST_IMAGE="public.ecr.aws/docker/library/hello-world:latest"

print_message() {
    echo -e "${1}${2}${NC}"
}

usage() {
    cat << EOF
Usage: $0 --project PROJECT --env ENV [OPTIONS]

Push a test image to the Tokyo (source) ECR repository, wait for it to
replicate into the Osaka (destination) repository, then print both
repositories' lifecycle policies to confirm they are configured
independently.

OPTIONS:
    -p, --project PROJECT       Project name (required)
    -e, --env ENV                Environment name, e.g. dev/stg/prd (required)
    --profile PROFILE            AWS CLI profile (default: <project>-<env>)
    --repo-suffix SUFFIX          ECR repositoryNameSuffix (default: sample-app)
    --source-region REGION       Source (Tokyo) region (default: ap-northeast-1)
    --dest-region REGION         Destination (Osaka) region (default: ap-northeast-3)
    --tag TAG                     Image tag to push (default: crr-test-<timestamp>)
    --timeout SECONDS             Max seconds to wait for replication (default: 300)
    --interval SECONDS            Polling interval in seconds (default: 10)
    --cleanup                     Delete the test image from both repositories afterwards
    -h, --help                    Show this help message

EXAMPLES:
    # Push a test image and wait for it to replicate to Osaka
    $0 --project myproject --env dev

    # Same, but remove the test image from both regions afterwards
    $0 --project myproject --env dev --cleanup
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
            --repo-suffix)
                REPO_SUFFIX="$2"
                shift 2
                ;;
            --source-region)
                SOURCE_REGION="$2"
                shift 2
                ;;
            --dest-region)
                DEST_REGION="$2"
                shift 2
                ;;
            --tag)
                TAG="$2"
                shift 2
                ;;
            --timeout)
                TIMEOUT="$2"
                shift 2
                ;;
            --interval)
                INTERVAL="$2"
                shift 2
                ;;
            --cleanup)
                CLEANUP=true
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

    REPO_NAME="${PROJECT}-${ENVIRONMENT}-${REPO_SUFFIX}"
}

check_requirements() {
    for cmd in aws docker jq; do
        if ! command -v "$cmd" &> /dev/null; then
            print_message "$RED" "Error: ${cmd} is not installed"
            exit 1
        fi
    done
}

# Wraps `aws` with the resolved --profile for this script; region is passed explicitly per call.
aws_cmd() {
    local args=("$@")
    if [ -n "$PROFILE" ]; then
        args+=(--profile "$PROFILE")
    fi
    aws "${args[@]}"
}

verify_credentials() {
    print_message "$BLUE" "Verifying AWS credentials (profile: ${PROFILE})..."
    if ! aws_cmd sts get-caller-identity --region "$SOURCE_REGION" > /dev/null; then
        print_message "$RED" "Error: could not authenticate with profile '${PROFILE}'"
        exit 1
    fi
}

verify_repositories_exist() {
    print_message "$BLUE" "Checking source repository in ${SOURCE_REGION}: ${REPO_NAME}"
    if ! aws_cmd ecr describe-repositories --region "$SOURCE_REGION" --repository-names "$REPO_NAME" > /dev/null 2>&1; then
        print_message "$RED" "Error: source repository '${REPO_NAME}' not found in ${SOURCE_REGION}"
        print_message "$YELLOW" "Make sure EcrCrrTokyoStack has been deployed for this project/env"
        exit 1
    fi

    print_message "$BLUE" "Checking destination repository in ${DEST_REGION}: ${REPO_NAME}"
    if ! aws_cmd ecr describe-repositories --region "$DEST_REGION" --repository-names "$REPO_NAME" > /dev/null 2>&1; then
        print_message "$RED" "Error: destination repository '${REPO_NAME}' not found in ${DEST_REGION}"
        print_message "$YELLOW" "Make sure EcrCrrOsakaStack has been deployed for this project/env"
        exit 1
    fi
}

push_test_image() {
    local account_id
    account_id=$(aws_cmd sts get-caller-identity --region "$SOURCE_REGION" --query Account --output text)
    local source_uri="${account_id}.dkr.ecr.${SOURCE_REGION}.amazonaws.com/${REPO_NAME}:${TAG}"

    print_message "$BLUE" "Logging in to ${SOURCE_REGION} ECR..."
    aws_cmd ecr get-login-password --region "$SOURCE_REGION" | \
        docker login --username AWS --password-stdin "${account_id}.dkr.ecr.${SOURCE_REGION}.amazonaws.com" > /dev/null

    print_message "$BLUE" "Pulling test image: ${SOURCE_TEST_IMAGE}"
    docker pull "$SOURCE_TEST_IMAGE" > /dev/null

    print_message "$BLUE" "Tagging and pushing: ${source_uri}"
    docker tag "$SOURCE_TEST_IMAGE" "$source_uri"
    docker push "$source_uri" > /dev/null

    IMAGE_DIGEST=$(aws_cmd ecr describe-images \
        --region "$SOURCE_REGION" \
        --repository-name "$REPO_NAME" \
        --image-ids "imageTag=${TAG}" \
        --query 'imageDetails[0].imageDigest' \
        --output text)

    print_message "$GREEN" "Pushed. Digest: ${IMAGE_DIGEST}"
}

# Polls the destination repository until the pushed digest appears, or TIMEOUT is reached.
wait_for_replication() {
    print_message "$BLUE" "Waiting for replication to ${DEST_REGION} (timeout: ${TIMEOUT}s, interval: ${INTERVAL}s)..."

    local elapsed=0
    while [ "$elapsed" -lt "$TIMEOUT" ]; do
        if aws_cmd ecr describe-images \
            --region "$DEST_REGION" \
            --repository-name "$REPO_NAME" \
            --image-ids "imageDigest=${IMAGE_DIGEST}" > /dev/null 2>&1; then
            print_message "$GREEN" "Replicated to ${DEST_REGION} after ~${elapsed}s"
            return 0
        fi
        sleep "$INTERVAL"
        elapsed=$((elapsed + INTERVAL))
        print_message "$YELLOW" "  ...still waiting (${elapsed}s elapsed)"
    done

    print_message "$RED" "Error: image did not replicate to ${DEST_REGION} within ${TIMEOUT}s"
    exit 1
}

# Prints each region's lifecycle policy to demonstrate they are configured independently.
compare_lifecycle_policies() {
    print_message "$BLUE" "--- Source lifecycle policy (${SOURCE_REGION}) ---"
    aws_cmd ecr get-lifecycle-policy \
        --region "$SOURCE_REGION" \
        --repository-name "$REPO_NAME" \
        --query 'lifecyclePolicyText' --output text | jq .

    print_message "$BLUE" "--- Destination lifecycle policy (${DEST_REGION}) ---"
    aws_cmd ecr get-lifecycle-policy \
        --region "$DEST_REGION" \
        --repository-name "$REPO_NAME" \
        --query 'lifecyclePolicyText' --output text | jq .
}

cleanup_test_image() {
    print_message "$BLUE" "Cleaning up test image (tag: ${TAG}) from both regions..."
    aws_cmd ecr batch-delete-image \
        --region "$SOURCE_REGION" \
        --repository-name "$REPO_NAME" \
        --image-ids "imageTag=${TAG}" > /dev/null
    aws_cmd ecr batch-delete-image \
        --region "$DEST_REGION" \
        --repository-name "$REPO_NAME" \
        --image-ids "imageDigest=${IMAGE_DIGEST}" > /dev/null
    print_message "$GREEN" "Cleaned up."
}

main() {
    print_message "$BLUE" "==================================================="
    print_message "$BLUE" "  ECR Cross-Region Replication Test"
    print_message "$BLUE" "==================================================="
    echo

    check_requirements
    parse_args "$@"
    validate_args
    verify_credentials
    verify_repositories_exist

    push_test_image
    wait_for_replication
    compare_lifecycle_policies

    if [ "$CLEANUP" = true ]; then
        cleanup_test_image
    fi

    echo
    print_message "$GREEN" "==================================================="
    print_message "$GREEN" "  Done. Replication verified: ${REPO_NAME}:${TAG}"
    print_message "$GREEN" "  ${SOURCE_REGION} -> ${DEST_REGION}"
    print_message "$GREEN" "==================================================="
}

main "$@"
