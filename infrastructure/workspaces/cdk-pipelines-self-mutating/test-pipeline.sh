#!/bin/bash

#######################################
# test-pipeline.sh
#
# End-to-end check of the deployed CDK Pipelines pipeline. `cdk deploy` of the pipeline stack proves
# nothing about whether the pipeline actually works, so this drives it through a real release:
#
#   1. waits for the first run to build, self-mutate and deploy Dev, then stop at the manual approval
#   2. asserts Dev is live (smoke) and Prod is NOT deployed yet (the approval gate holds)
#   3. approves, and asserts Prod is live
#   4. pushes ONE commit (via the CodeCommit API) that changes both the application version and the
#      pipeline definition (adds a SecurityCheck step), then asserts
#        - the pipeline re-defined ITSELF (UpdatePipeline ran; Dev now has a SecurityCheck action)
#        - the new commit reached Dev (new version) and waits at the approval again
#        - approving deploys the new version to Prod
#
# Requires: aws CLI, jq.
#
# Usage:
#   ./test-pipeline.sh --project PROJECT --env ENV [OPTIONS]
#
# Examples:
#   ./test-pipeline.sh --project myproject --env dev
#   ./test-pipeline.sh --project myproject --env dev --cleanup
#   ./test-pipeline.sh --project myproject --env dev --destroy-only
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
TIMEOUT=900
INTERVAL=15
CLEANUP=false
DESTROY_ONLY=false

PREFIX=""
REPO=""
PIPELINE=""
PASS=0
FAIL=0

print_message() {
    echo -e "${1}${2}${NC}"
}

usage() {
    cat << EOF
Usage: $0 --project PROJECT --env ENV [OPTIONS]

Drive the deployed pipeline through a release and a self-mutation, asserting each step.
Deploy first: the repository stack (workspace root), then the pipeline stack (cd app && cdk deploy).

OPTIONS:
    -p, --project PROJECT     Project name (required)
    -e, --env ENV             Environment name, e.g. dev/stg/prd (required)
    --profile PROFILE         AWS CLI profile (default: <project>-<env>)
    --region REGION           AWS region (default: ap-northeast-1)
    --timeout SECONDS         Max seconds to wait for each pipeline milestone (default: 900)
    --interval SECONDS        Polling interval in seconds (default: 15)
    --cleanup                 Delete Prod/Dev app stacks, the pipeline stack and the repository stack afterwards
    --destroy-only            Only delete the stacks (no verification)
    -h, --help                Show this help message

EXAMPLES:
    $0 --project myproject --env dev
    $0 --project myproject --env dev --cleanup
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
            --timeout) TIMEOUT="$2"; shift 2 ;;
            --interval) INTERVAL="$2"; shift 2 ;;
            --cleanup) CLEANUP=true; shift ;;
            --destroy-only) DESTROY_ONLY=true; shift ;;
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
    # Must match app/lib/naming.ts
    PREFIX="${PROJECT}-${ENVIRONMENT}-cdkp"
    REPO="${PREFIX}-app"
    PIPELINE="${PREFIX}-pipeline"
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

pipeline_state() {
    aws_cmd codepipeline get-pipeline-state --name "$PIPELINE" --output json
}

print_stage_summary() {
    pipeline_state | jq -r '.stageStates[] | "    \(.stageName): \(.latestExecution.status // "-")"'
}

# Token of the manual approval action if it is currently waiting for a decision (empty otherwise).
approval_token() {
    pipeline_state | jq -r '[.stageStates[] | select(.stageName=="Prod") | .actionStates[]
        | select(.actionName=="PromoteToProd" and .latestExecution.status=="InProgress") | .latestExecution.token][0] // empty'
}

failed_stage() {
    pipeline_state | jq -r '[.stageStates[] | select(.latestExecution.status=="Failed") | .stageName][0] // empty'
}

# wait_for_approval [ignore_token]  -> prints the token; exits the script if a stage fails or time runs out
wait_for_approval() {
    local ignore="${1:-}" deadline=$((SECONDS + TIMEOUT)) token failed
    while true; do
        token="$(approval_token)"
        if [[ -n "$token" && "$token" != "$ignore" ]]; then
            echo "$token"; return 0
        fi
        failed="$(failed_stage)"
        if [[ -n "$failed" ]]; then
            print_message "$RED" "Pipeline stage failed: $failed" >&2
            print_stage_summary >&2
            return 1
        fi
        if [[ $SECONDS -ge $deadline ]]; then
            print_message "$RED" "Timed out waiting for the approval step" >&2
            print_stage_summary >&2
            return 1
        fi
        print_message "$YELLOW" "    ... waiting (approval not reached yet)" >&2
        print_stage_summary >&2
        sleep "$INTERVAL"
    done
}

approve() {
    aws_cmd codepipeline put-approval-result --pipeline-name "$PIPELINE" --stage-name Prod --action-name PromoteToProd \
        --result "summary=Approved by test-pipeline.sh,status=Approved" --token "$1" > /dev/null
}

wait_for_pipeline_success() {
    local deadline=$((SECONDS + TIMEOUT)) status failed
    while true; do
        status="$(aws_cmd codepipeline list-pipeline-executions --pipeline-name "$PIPELINE" \
            --query 'pipelineExecutionSummaries[0].status' --output text)"
        [[ "$status" == "Succeeded" ]] && return 0
        failed="$(failed_stage)"
        if [[ -n "$failed" || $SECONDS -ge $deadline ]]; then
            print_stage_summary >&2
            return 1
        fi
        sleep "$INTERVAL"
    done
}

# invoke_stage STAGE -> prints the function's JSON response (empty if the stack does not exist)
invoke_stage() {
    local fn="${PREFIX}-$(tr '[:upper:]' '[:lower:]' <<< "$1")-hello"
    aws_cmd lambda invoke --function-name "$fn" --cli-binary-format raw-in-base64-out /tmp/test-pipeline-response.json > /dev/null 2>&1 || return 0
    cat /tmp/test-pipeline-response.json
}

stack_exists() {
    aws_cmd cloudformation describe-stacks --stack-name "$1" > /dev/null 2>&1
}

dev_actions() {
    aws_cmd codepipeline get-pipeline --name "$PIPELINE" --query 'pipeline.stages[?name==`Dev`].actions[].name' --output json
}

initial_release() {
    print_message "$BLUE" "==> First run: Source -> Build -> UpdatePipeline -> Dev, then the approval gate"
    local token
    token="$(wait_for_approval)" || { check "first run reached the manual approval" false "a stage failed or timed out (see above)"; return 1; }
    check "first run built, self-mutated and deployed Dev, and stopped at the manual approval" true

    local dev prod_stack_state="absent"
    dev="$(invoke_stage Dev)"
    check "Dev is live and reports stage=Dev, version=1.0.0" "$([[ "$(jq -r '[.stage,.version]|join(" ")' <<< "$dev" 2>/dev/null)" == "Dev 1.0.0" ]] && echo true || echo false)" "$dev"
    stack_exists "${PREFIX}-prod-hello" && prod_stack_state="present"
    check "Prod is NOT deployed before approval (the gate holds)" "$([[ "$prod_stack_state" == "absent" ]] && echo true || echo false)"

    print_message "$BLUE" "==> Approving the promotion to Prod"
    approve "$token"
    if wait_for_pipeline_success; then
        check "run finished after approval" true
    else
        check "run finished after approval" false
        return 1
    fi
    local prod
    prod="$(invoke_stage Prod)"
    check "Prod is live and reports stage=Prod, version=1.0.0" "$([[ "$(jq -r '[.stage,.version]|join(" ")' <<< "$prod" 2>/dev/null)" == "Prod 1.0.0" ]] && echo true || echo false)" "$prod"
    LAST_TOKEN="$token"
}

# Change app/lib/config.ts through the CodeCommit API (no git client needed).
push_change_commit() {
    local parent file
    parent="$(aws_cmd codecommit get-branch --repository-name "$REPO" --branch-name main --query branch.commitId --output text)"
    file="$(mktemp)"
    aws_cmd codecommit get-file --repository-name "$REPO" --commit-specifier "$parent" --file-path lib/config.ts \
        --query fileContent --output text | base64 -d > "$file"
    sed -i "s/APP_VERSION = '1.0.0'/APP_VERSION = '1.1.0'/; s/ENABLE_SECURITY_CHECK = false/ENABLE_SECURITY_CHECK = true/" "$file"
    NEW_COMMIT="$(aws_cmd codecommit put-file --repository-name "$REPO" --branch-name main --parent-commit-id "$parent" \
        --file-path lib/config.ts --file-content "fileb://$file" \
        --commit-message "test-pipeline.sh: release 1.1.0 and add a SecurityCheck step" --query commitId --output text)"
    rm -f "$file"
    echo "    pushed commit $NEW_COMMIT (APP_VERSION 1.1.0, ENABLE_SECURITY_CHECK true)"
}

self_mutation_release() {
    print_message "$BLUE" "==> Pushing one commit that changes the app AND the pipeline definition"
    local before
    before="$(dev_actions)"
    check "before: Dev has no SecurityCheck action" "$([[ "$(jq -r 'index("SecurityCheck") // "none"' <<< "$before")" == "none" ]] && echo true || echo false)" "$before"

    push_change_commit
    print_message "$BLUE" "==> Waiting for the new run (it must re-define the pipeline, restart, deploy Dev, and wait at the approval)"
    local token
    token="$(wait_for_approval "$LAST_TOKEN")" || { check "second run reached the manual approval" false "a stage failed or timed out (see above)"; return 1; }

    local after
    after="$(dev_actions)"
    check "the pipeline re-defined ITSELF: Dev now has a SecurityCheck action" "$([[ "$(jq -r 'index("SecurityCheck") // "none"' <<< "$after")" != "none" ]] && echo true || echo false)" "$after"

    local exec_id revision
    exec_id="$(pipeline_state | jq -r '[.stageStates[] | select(.stageName=="Prod") | .latestExecution.pipelineExecutionId][0]')"
    revision="$(aws_cmd codepipeline get-pipeline-execution --pipeline-name "$PIPELINE" --pipeline-execution-id "$exec_id" \
        --query 'pipelineExecution.artifactRevisions[0].revisionId' --output text)"
    check "the run waiting at the approval was built from the new commit" "$([[ "$revision" == "$NEW_COMMIT" ]] && echo true || echo false)" "run revision $revision"

    local dev
    dev="$(invoke_stage Dev)"
    check "Dev runs the new version 1.1.0" "$([[ "$(jq -r '[.stage,.version]|join(" ")' <<< "$dev" 2>/dev/null)" == "Dev 1.1.0" ]] && echo true || echo false)" "$dev"
    local prod_before
    prod_before="$(invoke_stage Prod)"
    check "Prod still runs 1.0.0 until approved" "$([[ "$(jq -r .version <<< "$prod_before" 2>/dev/null)" == "1.0.0" ]] && echo true || echo false)" "$prod_before"

    approve "$token"
    if wait_for_pipeline_success; then
        check "second run finished after approval" true
    else
        check "second run finished after approval" false
        return 1
    fi
    local prod
    prod="$(invoke_stage Prod)"
    check "Prod now runs 1.1.0" "$([[ "$(jq -r '[.stage,.version]|join(" ")' <<< "$prod" 2>/dev/null)" == "Prod 1.1.0" ]] && echo true || echo false)" "$prod"
}

delete_stack() {
    if stack_exists "$1"; then
        echo "    deleting $1"
        aws_cmd cloudformation delete-stack --stack-name "$1"
        aws_cmd cloudformation wait stack-delete-complete --stack-name "$1"
    else
        echo "    $1 not found (skipped)"
    fi
}

destroy_all() {
    print_message "$BLUE" "==> Deleting stacks (application stacks first: the pipeline created them, so it does not delete them)"
    delete_stack "${PREFIX}-prod-hello"
    delete_stack "${PREFIX}-dev-hello"
    delete_stack "${PREFIX}-pipeline"
    delete_stack "${PREFIX}-repository"
}

main() {
    parse_args "$@"
    validate_args
    check_requirements
    verify_credentials

    if [[ "$DESTROY_ONLY" == true ]]; then
        destroy_all
        exit 0
    fi

    if ! aws_cmd codepipeline get-pipeline --name "$PIPELINE" > /dev/null 2>&1; then
        print_message "$RED" "Error: pipeline $PIPELINE not found in $REGION. Deploy the repository stack, then run 'cdk deploy' in app/."
        exit 1
    fi
    LAST_TOKEN=""
    NEW_COMMIT=""

    initial_release && self_mutation_release || true
    [[ "$CLEANUP" == true ]] && destroy_all

    echo
    if [[ $FAIL -eq 0 ]]; then
        print_message "$GREEN" "All checks passed ($PASS)"
    else
        print_message "$RED" "$FAIL check(s) failed, $PASS passed"
        exit 1
    fi
}

main "$@"
