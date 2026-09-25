#!/bin/bash

#######################################
# test-semantic-search.sh
#
# End-to-end check of the deployed semantic search API:
#   1. seeds sample documents through POST /documents
#   2. waits until the DynamoDB Streams -> Lambda -> Bedrock pipeline has written each embedding
#   3. runs natural-language queries that share NO keywords with the target document
#      (including a Japanese query against English documents) and asserts the top hit
#   4. checks the INLINE_FILTER (category) is applied inside the vector search
#   5. checks re-embedding (REMOVE embeddedAt), request validation and API key enforcement
#
# A clean `cdk deploy` does not prove this pattern works: embedding is asynchronous and the vector
# index is eventually consistent, so only a real ingest -> search round trip does.
#
# Requires: aws CLI, curl, jq.
#
# Usage:
#   ./test-semantic-search.sh --project PROJECT --env ENV [OPTIONS]
#
# Examples:
#   ./test-semantic-search.sh --project myproject --env dev
#   ./test-semantic-search.sh --project myproject --env dev --cleanup
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
STACK_NAME=""
TIMEOUT=180
INTERVAL=5
CLEANUP=false

API_URL=""
API_KEY=""
TABLE_NAME=""
DOC_IDS=()
PASS=0
FAIL=0

print_message() {
    echo -e "${1}${2}${NC}"
}

usage() {
    cat << EOF
Usage: $0 --project PROJECT --env ENV [OPTIONS]

Seed sample documents into the semantic search API, wait for their embeddings, then assert that
semantic queries, the category filter, request validation and API key enforcement behave.

OPTIONS:
    -p, --project PROJECT     Project name (required)
    -e, --env ENV             Environment name, e.g. dev/stg/prd (required)
    --profile PROFILE         AWS CLI profile (default: <project>-<env>)
    --region REGION           AWS region (default: ap-northeast-1)
    --stack-name NAME         CloudFormation stack name
                              (default: <project>-<env>-dynamodb-vector-search-semantic-api)
    --timeout SECONDS         Max seconds to wait for embeddings / index (default: 180)
    --interval SECONDS        Polling interval in seconds (default: 5)
    --cleanup                 Delete the seeded documents afterwards
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
            --stack-name) STACK_NAME="$2"; shift 2 ;;
            --timeout) TIMEOUT="$2"; shift 2 ;;
            --interval) INTERVAL="$2"; shift 2 ;;
            --cleanup) CLEANUP=true; shift ;;
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
    STACK_NAME="${STACK_NAME:-${PROJECT}-${ENVIRONMENT}-dynamodb-vector-search-semantic-api}"
}

check_requirements() {
    local missing=0
    for cmd in aws curl jq; do
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

# Stack output keys are prefixed by the CDK Stage construct path, so match on the suffix.
stack_output() {
    aws_cmd cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?ends_with(OutputKey, '$1')].OutputValue | [0]" --output text
}

load_stack_info() {
    print_message "$BLUE" "==> Reading stack outputs from $STACK_NAME"
    API_URL="$(stack_output ApiUrl)"
    TABLE_NAME="$(stack_output TableName)"
    local key_id
    key_id="$(stack_output ApiKeyId)"
    if [[ -z "$API_URL" || "$API_URL" == "None" || -z "$key_id" || "$key_id" == "None" ]]; then
        print_message "$RED" "Error: stack outputs not found. Is $STACK_NAME deployed in $REGION?"
        exit 1
    fi
    API_URL="${API_URL%/}"
    API_KEY="$(aws_cmd apigateway get-api-key --api-key "$key_id" --include-value --query value --output text)"
    echo "    API:   $API_URL"
    echo "    Table: $TABLE_NAME"
}

# api METHOD PATH [BODY] [--no-key] -> prints "<http_status>" then the response body
api() {
    local method="$1" path="$2" body="${3:-}" use_key=true
    [[ "${4:-}" == "--no-key" ]] && use_key=false
    local args=(-s -w '\n%{http_code}' -X "$method" "$API_URL$path")
    [[ "$use_key" == true ]] && args+=(-H "x-api-key: $API_KEY")
    [[ -n "$body" ]] && args+=(-H 'Content-Type: application/json' -d "$body")
    local out
    out="$(curl "${args[@]}")"
    echo "${out##*$'\n'}"
    echo "${out%$'\n'*}"
}

check() {
    local name="$1" ok="$2" detail="${3:-}"
    if [[ "$ok" == "true" ]]; then
        PASS=$((PASS + 1)); print_message "$GREEN" "  PASS  $name"
    else
        FAIL=$((FAIL + 1)); print_message "$RED" "  FAIL  $name ${detail:+($detail)}"
    fi
}

# category|title|body
SAMPLE_DOCS=(
    "database|Speeding up queries with secondary indexes|Adding a global secondary index lets you query by an attribute other than the primary key without scanning the entire table, dramatically cutting latency."
    "database|Avoiding hot partitions|Spread write traffic evenly across partition key values, for example by adding a random suffix, so that one key does not exhaust its throughput."
    "serverless|Reducing Lambda cold starts|Use provisioned concurrency, smaller deployment packages and the arm64 architecture to lower the initialization delay when a function is invoked after being idle."
    "serverless|Handling failures in event-driven pipelines|Configure a dead-letter queue and retries so messages that repeatedly fail processing are set aside for later inspection instead of blocking the stream."
    "networking|Private connectivity to AWS services|VPC endpoints let instances in private subnets reach services such as S3 without traversing the public internet or a NAT gateway."
    "networking|Distributing traffic across servers|An Application Load Balancer spreads incoming HTTP requests across healthy targets in multiple Availability Zones."
    "security|Least privilege for IAM roles|Grant only the permissions a workload needs, scope resources by ARN, and review unused access regularly."
    "security|Encrypting data at rest|Use customer managed KMS keys to encrypt storage and control who can decrypt, with automatic yearly key rotation."
    "cost|Reducing your AWS bill|Right-size instances, use Savings Plans for steady workloads and delete unattached volumes and idle resources."
    "cost|Setting spending alerts|AWS Budgets can notify you by email when actual or forecast spend crosses a threshold."
)

seed_documents() {
    print_message "$BLUE" "==> Seeding ${#SAMPLE_DOCS[@]} documents"
    local entry category title body payload result status
    for entry in "${SAMPLE_DOCS[@]}"; do
        IFS='|' read -r category title body <<< "$entry"
        payload="$(jq -nc --arg t "$title" --arg b "$body" --arg c "$category" '{title:$t,body:$b,category:$c}')"
        result="$(api POST /documents "$payload")"
        status="$(head -n1 <<< "$result")"
        if [[ "$status" != "202" ]]; then
            print_message "$RED" "Error: POST /documents returned $status: $(tail -n +2 <<< "$result")"
            exit 1
        fi
        DOC_IDS+=("$(tail -n +2 <<< "$result" | jq -r .docId)")
    done
    check "all ${#SAMPLE_DOCS[@]} documents accepted (202)" true
}

wait_for_embeddings() {
    print_message "$BLUE" "==> Waiting for embeddings (Streams -> Lambda -> Bedrock -> UpdateItem)"
    local deadline=$((SECONDS + TIMEOUT)) pending id status
    while true; do
        pending=0
        for id in "${DOC_IDS[@]}"; do
            status="$(tail -n +2 <<< "$(api GET "/documents/$id")" | jq -r .embeddingStatus)"
            [[ "$status" == "ready" ]] || pending=$((pending + 1))
        done
        echo "    pending: $pending / ${#DOC_IDS[@]}"
        [[ $pending -eq 0 ]] && break
        if [[ $SECONDS -ge $deadline ]]; then
            check "all embeddings ready within ${TIMEOUT}s" false "$pending still pending; check the embed Lambda logs and DLQ"
            return 1
        fi
        sleep "$INTERVAL"
    done
    check "all embeddings ready" true
}

# search QUERY [CATEGORY] -> prints the JSON body; retries while the vector index is still catching up
search() {
    local q="$1" category="${2:-}" deadline=$((SECONDS + TIMEOUT)) result status body
    while true; do
        result="$(api GET "/search?k=5&q=$(jq -rn --arg q "$q" '$q|@uri')${category:+&category=$category}")"
        status="$(head -n1 <<< "$result")"
        body="$(tail -n +2 <<< "$result")"
        if [[ "$status" == "200" && "$(jq -r .count <<< "$body")" -gt 0 ]]; then
            echo "$body"; return 0
        fi
        if [[ $SECONDS -ge $deadline ]]; then
            echo "$body"; return 1
        fi
        sleep "$INTERVAL"
    done
}

assert_top_hit() {
    local query="$1" expected="$2" body top
    body="$(search "$query")" || true
    top="$(jq -r '.results[0].title // "(none)"' <<< "$body")"
    check "\"$query\" -> top hit \"$top\"" "$([[ "$top" == *"$expected"* ]] && echo true || echo false)" "expected title containing \"$expected\""
    jq -r '.results[:3][] | "        \(.similarity | tostring | .[0:6])  [\(.category)] \(.title)"' <<< "$body"
}

run_semantic_tests() {
    print_message "$BLUE" "==> Semantic queries (no shared keywords with the target document)"
    assert_top_hit "my table lookups are slow when I filter by a non-key column" "secondary indexes"
    assert_top_hit "my function is slow the first time it runs after sitting idle" "cold starts"
    assert_top_hit "keep traffic off the internet when talking to storage from private subnets" "Private connectivity"
    assert_top_hit "予算を超えそうなときにメールで知らせてほしい" "spending alerts"
}

run_filter_tests() {
    print_message "$BLUE" "==> INLINE_FILTER (category) is applied inside the vector search"
    local body count categories
    body="$(search "how do I make things faster and cheaper" database)" || true
    count="$(jq -r .count <<< "$body")"
    categories="$(jq -r '[.results[].category] | unique | join(",")' <<< "$body")"
    check "category=database only returns database documents" "$([[ "$categories" == "database" ]] && echo true || echo false)" "got: $categories"
    # k=5 but only 2 database documents exist: exact top-k under the filter returns exactly those 2.
    check "filter is applied before top-k (2 database docs returned with k=5)" "$([[ "$count" == "2" ]] && echo true || echo false)" "count=$count"
}

run_negative_tests() {
    print_message "$BLUE" "==> Request validation and API key enforcement"
    local status
    status="$(head -n1 <<< "$(api GET /search)")"
    check "GET /search without q -> 400" "$([[ "$status" == "400" ]] && echo true || echo false)" "got $status"
    status="$(head -n1 <<< "$(api POST /documents '{"title":"only a title"}')")"
    check "POST /documents without body text -> 400" "$([[ "$status" == "400" ]] && echo true || echo false)" "got $status"
    status="$(head -n1 <<< "$(api GET '/search?q=test' '' --no-key)")"
    check "GET /search without API key -> 403" "$([[ "$status" == "403" ]] && echo true || echo false)" "got $status"
}

# Removing `embeddedAt` re-arms the stream filter, so the item is embedded again (e.g. after a model
# change). Also proves the write-back record itself does not re-trigger the function in a loop.
run_reembed_test() {
    print_message "$BLUE" "==> Re-embedding by removing embeddedAt"
    local id="${DOC_IDS[0]}" before after deadline=$((SECONDS + TIMEOUT))
    before="$(tail -n +2 <<< "$(api GET "/documents/$id")" | jq -r .embeddedAt)"
    aws_cmd dynamodb update-item --table-name "$TABLE_NAME" --key "{\"docId\":{\"S\":\"$id\"}}" \
        --update-expression 'REMOVE embeddedAt' > /dev/null
    while true; do
        after="$(tail -n +2 <<< "$(api GET "/documents/$id")" | jq -r .embeddedAt)"
        [[ "$after" != "null" && "$after" != "$before" ]] && break
        if [[ $SECONDS -ge $deadline ]]; then
            check "item re-embedded after REMOVE embeddedAt" false "embeddedAt still $after"
            return
        fi
        sleep "$INTERVAL"
    done
    check "item re-embedded after REMOVE embeddedAt" true
}

cleanup_documents() {
    print_message "$BLUE" "==> Deleting ${#DOC_IDS[@]} seeded documents"
    local id
    for id in "${DOC_IDS[@]}"; do
        aws_cmd dynamodb delete-item --table-name "$TABLE_NAME" --key "{\"docId\":{\"S\":\"$id\"}}"
    done
}

main() {
    parse_args "$@"
    validate_args
    check_requirements
    verify_credentials
    load_stack_info
    seed_documents
    if wait_for_embeddings; then
        run_semantic_tests
        run_filter_tests
        run_reembed_test
    fi
    run_negative_tests
    [[ "$CLEANUP" == true ]] && cleanup_documents

    echo
    if [[ $FAIL -eq 0 ]]; then
        print_message "$GREEN" "All checks passed ($PASS)"
    else
        print_message "$RED" "$FAIL check(s) failed, $PASS passed"
        exit 1
    fi
}

main "$@"
