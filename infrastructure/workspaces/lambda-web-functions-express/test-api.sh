#!/bin/bash

#######################################
# test-api.sh
#
# Operational check for the Lambda Web Functions pattern. Resolves the
# CloudFront URL and the Web Function endpoint from the stack outputs, then:
#
#   1. health        GET /health through CloudFront
#   2. crud          Todos create / read / update / list / delete
#   3. validation    request validation done by the app (no API Gateway)
#   4. direct        unsigned request straight to the IamAuth endpoint is rejected
#   5. concurrency   parallel I/O-bound requests share a few execution environments
#   6. stream        Server-Sent Events arrive incrementally through CloudFront
#   7. background    work continues after the response and reaches CloudWatch Logs
#   8. throttle      (opt-in) burst above the endpoint rate limit returns 429
#
# The /debug routes require enableDebugRoutes=true (dev parameters).
#
# Requires: aws CLI v2 (with `lambda-web`), curl, jq.
#
# Usage:
#   ./test-api.sh --project PROJECT --env ENV [OPTIONS]
#
# Examples:
#   ./test-api.sh --project myproject --env dev
#   ./test-api.sh --project myproject --env dev --only concurrency --parallel 150
#   ./test-api.sh --project myproject --env dev --throttle
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
ONLY=""
PARALLEL=30
SLEEP_MS=2000
THROTTLE=false
THROTTLE_REQUESTS=400

STACK_NAME=""
BASE_URL=""
ENDPOINT_DOMAIN=""
FUNCTION_NAME=""
LOG_GROUP=""
PASSED=0
FAILED=0
WORK_DIR=""

print_message() {
    echo -e "${1}${2}${NC}"
}

usage() {
    cat << EOF
Usage: $0 --project PROJECT --env ENV [OPTIONS]

Exercise the deployed Lambda Web Functions Todos API through CloudFront and
report what the platform does (multi-concurrency, streaming, background work,
endpoint access control, throttling).

OPTIONS:
    -p, --project PROJECT     Project name (required)
    -e, --env ENV              Environment name, e.g. dev (required)
    --profile PROFILE          AWS CLI profile (default: <project>-<env>)
    --region REGION            Region of the main stack (default: ap-northeast-1)
    --only CHECK               Run a single check: health|crud|validation|direct|concurrency|stream|background|throttle
    --parallel N               Parallel requests for the concurrency check (default: 30)
    --sleep-ms MS              Server-side wait per concurrency request (default: 2000)
    --throttle                 Also run the throttle check (sends a burst of requests)
    --throttle-requests N      Requests in the throttle burst (default: 400)
    -h, --help                 Show this help message

EXAMPLES:
    $0 --project myproject --env dev
    $0 --project myproject --env dev --only concurrency --parallel 150
    $0 --project myproject --env dev --throttle
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
            --only) ONLY="$2"; shift 2 ;;
            --parallel) PARALLEL="$2"; shift 2 ;;
            --sleep-ms) SLEEP_MS="$2"; shift 2 ;;
            --throttle) THROTTLE=true; shift ;;
            --throttle-requests) THROTTLE_REQUESTS="$2"; shift 2 ;;
            *) print_message "$RED" "Unknown option: $1"; usage ;;
        esac
    done
}

validate_args() {
    if [[ -z "$PROJECT" || -z "$ENVIRONMENT" ]]; then
        print_message "$RED" "--project and --env are required"
        usage
    fi
    PROFILE="${PROFILE:-${PROJECT}-${ENVIRONMENT}}"
    STACK_NAME="${PROJECT}-${ENVIRONMENT}-lambda-web-functions-express"
}

check_requirements() {
    local cmd
    for cmd in aws curl jq; do
        if ! command -v "$cmd" > /dev/null 2>&1; then
            print_message "$RED" "Required command not found: $cmd"
            exit 1
        fi
    done
    if ! aws lambda-web help > /dev/null 2>&1; then
        print_message "$YELLOW" "aws lambda-web is not available: update AWS CLI v2 (optional, used for endpoint details)"
    fi
}

aws_cmd() {
    aws --profile "$PROFILE" --region "$REGION" "$@"
}

verify_credentials() {
    if ! aws_cmd sts get-caller-identity > /dev/null 2>&1; then
        print_message "$RED" "Invalid AWS credentials for profile '$PROFILE' (try: aws sso login --profile $PROFILE)"
        exit 1
    fi
}

stack_output() {
    aws_cmd cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

load_outputs() {
    BASE_URL=$(stack_output DistributionUrl)
    ENDPOINT_DOMAIN=$(stack_output EndpointDomainName)
    FUNCTION_NAME=$(stack_output WebFunctionName)
    LOG_GROUP=$(stack_output LogGroupName)
    print_message "$BLUE" "CloudFront : $BASE_URL"
    print_message "$BLUE" "Endpoint   : https://$ENDPOINT_DOMAIN"
    print_message "$BLUE" "Function   : $FUNCTION_NAME"
    print_message "$BLUE" "Log group  : $LOG_GROUP"
}

pass() { PASSED=$((PASSED + 1)); print_message "$GREEN" "  PASS: $1"; }
fail() { FAILED=$((FAILED + 1)); print_message "$RED" "  FAIL: $1"; }

expect_status() {
    local label="$1" expected="$2" actual="$3"
    if [[ "$actual" == "$expected" ]]; then pass "$label ($actual)"; else fail "$label (expected $expected, got $actual)"; fi
}

# Writes body to $WORK_DIR/body and headers to $WORK_DIR/headers; prints the status code.
http() {
    local method="$1" url="$2" data="${3:-}"
    local args=(-s -o "$WORK_DIR/body" -D "$WORK_DIR/headers" -w '%{http_code}' -X "$method" "$url")
    if [[ -n "$data" ]]; then
        args+=(-H 'Content-Type: application/json' --data "$data")
    fi
    curl "${args[@]}"
}

check_health() {
    print_message "$YELLOW" "[1] health"
    local status
    status=$(http GET "$BASE_URL/health")
    expect_status "GET /health through CloudFront" 200 "$status"
    local request_id
    request_id=$(grep -i '^lambda-web-request-id:' "$WORK_DIR/headers" | tr -d '\r' | awk '{print $2}' || true)
    if [[ -n "$request_id" ]]; then pass "lambda-web-request-id header present ($request_id)"; else fail "lambda-web-request-id header missing"; fi
    if grep -qi '^strict-transport-security:' "$WORK_DIR/headers"; then pass "helmet security headers present"; else fail "helmet headers missing"; fi
}

check_crud() {
    print_message "$YELLOW" "[2] crud"
    local status id
    status=$(http POST "$BASE_URL/todos" '{"title":"verify web functions"}')
    expect_status "POST /todos" 201 "$status"
    id=$(jq -r .todoId "$WORK_DIR/body")
    status=$(http GET "$BASE_URL/todos/$id"); expect_status "GET /todos/:id" 200 "$status"
    status=$(http PUT "$BASE_URL/todos/$id" '{"title":"verified","completed":true}'); expect_status "PUT /todos/:id" 200 "$status"
    if [[ "$(jq -r .completed "$WORK_DIR/body")" == "true" ]]; then pass "update persisted"; else fail "update not persisted"; fi
    status=$(http GET "$BASE_URL/todos"); expect_status "GET /todos" 200 "$status"
    status=$(http DELETE "$BASE_URL/todos/$id"); expect_status "DELETE /todos/:id" 204 "$status"
    status=$(http GET "$BASE_URL/todos/$id"); expect_status "GET deleted item" 404 "$status"
    status=$(http PUT "$BASE_URL/todos/$id" '{"title":"ghost"}'); expect_status "PUT missing item" 404 "$status"
}

check_validation() {
    print_message "$YELLOW" "[3] validation"
    local status
    status=$(http POST "$BASE_URL/todos" '{}'); expect_status "missing title" 400 "$status"
    status=$(http POST "$BASE_URL/todos" '{"title":"ok","completed":"yes"}'); expect_status "non-boolean completed" 400 "$status"
    status=$(http POST "$BASE_URL/todos" '{"title":'); expect_status "malformed JSON" 400 "$status"
    status=$(http GET "$BASE_URL/nope"); expect_status "unknown route" 404 "$status"
}

check_direct() {
    print_message "$YELLOW" "[4] direct access to the IamAuth endpoint"
    local status
    status=$(http GET "https://$ENDPOINT_DOMAIN/health")
    if [[ "$status" == "403" || "$status" == "401" ]]; then
        pass "unsigned request rejected ($status)"
    else
        fail "unsigned request returned $status (expected 401/403)"
    fi
    print_message "$BLUE" "  body: $(head -c 200 "$WORK_DIR/body")"
}

check_concurrency() {
    print_message "$YELLOW" "[5] concurrency: $PARALLEL parallel requests, each waiting ${SLEEP_MS}ms"
    local out="$WORK_DIR/concurrency"
    mkdir -p "$out"
    # Warm one environment so the measurement is not dominated by a cold start.
    curl -s "$BASE_URL/debug/env" > /dev/null
    seq 1 "$PARALLEL" | xargs -P "$PARALLEL" -I{} \
        curl -s -o "$out/{}.json" -w '%{http_code} %{time_total}\n' "$BASE_URL/debug/sleep?ms=$SLEEP_MS" > "$out/status.txt"
    local ok envs max_inflight f
    ok=$(awk '$1==200' "$out/status.txt" | wc -l)
    # Throttled responses are HTML; keep only the JSON bodies.
    for f in "$out"/*.json; do jq -c 'select(.environmentId)' "$f" 2>/dev/null || true; done > "$out/ok.jsonl"
    envs=$(jq -s '[.[].environmentId] | unique | length' "$out/ok.jsonl")
    max_inflight=$(jq -s '[.[].maxInFlight] | max // 0' "$out/ok.jsonl")
    print_message "$BLUE" "  status codes: $(awk '{print $1}' "$out/status.txt" | sort | uniq -c | tr '\n' ' ')"
    print_message "$BLUE" "  distinct environments: $envs, max in-flight in one environment: $max_inflight"
    print_message "$BLUE" "  latency p50/p95/max (s): $(awk '$1==200{print $2}' "$out/status.txt" | sort -n | \
        awk '{a[NR]=$1} END{if(NR) printf "%.3f / %.3f / %.3f", a[int(NR*0.5)+(NR*0.5>int(NR*0.5))], a[int(NR*0.95)+(NR*0.95>int(NR*0.95))], a[NR]}')"
    local throttled other
    throttled=$(awk '$1==429' "$out/status.txt" | wc -l)
    other=$((PARALLEL - ok - throttled))
    if [[ "$other" -eq 0 ]]; then pass "no errors other than throttling ($ok OK, $throttled throttled)"; else fail "$other requests failed with non-429 errors"; fi
    if [[ "$throttled" -gt 0 ]]; then
        print_message "$YELLOW" "  WARN: $throttled x 429 — new environments start with a low dynamic concurrency limit and"
        print_message "$YELLOW" "        maxEnvironments caps scale-out; repeat the check to watch the limit ramp up (README: Verification Results)"
    fi
    if [[ "$envs" -lt "$PARALLEL" && "$max_inflight" -gt 1 ]]; then
        pass "requests shared execution environments ($envs envs for $PARALLEL requests)"
    else
        fail "no sharing observed ($envs envs, max in-flight $max_inflight)"
    fi
}

check_stream() {
    print_message "$YELLOW" "[6] streaming (SSE through CloudFront)"
    local start first last count
    start=$(date +%s%3N)
    first=""
    count=0
    while IFS= read -r line; do
        if [[ "$line" == data:* ]]; then
            count=$((count + 1))
            [[ -z "$first" ]] && first=$(( $(date +%s%3N) - start ))
        fi
    done < <(curl -sN "$BASE_URL/debug/stream?count=10&intervalMs=500")
    last=$(( $(date +%s%3N) - start ))
    print_message "$BLUE" "  events: $count, first event after ${first:-?}ms, stream closed after ${last}ms"
    if [[ "$count" -eq 10 && -n "$first" && "$first" -lt $((last - 2000)) ]]; then
        pass "events were delivered incrementally (not buffered until the end)"
    else
        fail "stream looks buffered or incomplete"
    fi
}

check_background() {
    print_message "$YELLOW" "[7] background work after the response"
    local status job_id since
    since=$(( $(date +%s) * 1000 ))
    status=$(http POST "$BASE_URL/debug/background?delayMs=3000")
    expect_status "POST /debug/background" 202 "$status"
    job_id=$(jq -r .jobId "$WORK_DIR/body")
    local found="" i
    for i in $(seq 1 12); do
        sleep 5
        found=$(aws_cmd logs filter-log-events --log-group-name "$LOG_GROUP" --start-time "$since" \
            --filter-pattern "\"$job_id\"" --query 'events[0].message' --output text 2>/dev/null || true)
        [[ -n "$found" && "$found" != "None" ]] && break
    done
    if [[ -n "$found" && "$found" != "None" ]]; then
        pass "background job finished after the response and was logged"
        print_message "$BLUE" "  log: $(echo "$found" | head -c 300)"
    else
        fail "background log line not found in $LOG_GROUP within 60s"
    fi
}

check_throttle() {
    print_message "$YELLOW" "[8] throttle: $THROTTLE_REQUESTS requests as fast as possible"
    local out="$WORK_DIR/throttle.txt"
    seq 1 "$THROTTLE_REQUESTS" | xargs -P 100 -I{} curl -s -o /dev/null -w '%{http_code}\n' "$BASE_URL/health" > "$out"
    print_message "$BLUE" "  status codes: $(sort "$out" | uniq -c | tr '\n' ' ')"
    if grep -q '^429$' "$out"; then pass "endpoint rate limit returned 429"; else print_message "$YELLOW" "  no 429 observed (burst may be below the limit)"; fi
}

run_check() {
    local name="$1"
    if [[ -z "$ONLY" || "$ONLY" == "$name" ]]; then
        "check_$name"
    fi
}

main() {
    parse_args "$@"
    validate_args
    check_requirements
    verify_credentials
    WORK_DIR=$(mktemp -d)
    trap 'rm -rf "$WORK_DIR"' EXIT
    load_outputs

    run_check health
    run_check crud
    run_check validation
    run_check direct
    run_check concurrency
    run_check stream
    run_check background
    if [[ "$THROTTLE" == "true" || "$ONLY" == "throttle" ]]; then
        check_throttle
    fi

    echo
    print_message "$BLUE" "Passed: $PASSED, Failed: $FAILED"
    [[ "$FAILED" -eq 0 ]]
}

main "$@"
