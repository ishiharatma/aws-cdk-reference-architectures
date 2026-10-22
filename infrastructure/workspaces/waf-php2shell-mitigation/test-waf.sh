#!/bin/bash

#######################################
# test-waf.sh
#
# Sends harmless requests that match (or deliberately miss) the PHP2Shell
# mitigation rules from the AWS Security Blog, through two paths:
#   cf  : client -> CloudFront (Web ACL, up to 64 KB body inspection) -> ALB (Web ACL, 8 KB) -> PHP
#   alb : client -> ALB (Web ACL, 8 KB fixed) -> PHP   (allow-listed verification IP only)
# and prints one row per request: HTTP status, which rule blocked it
# (x-php2shell-blocked-by response header) and which COUNT rules matched
# (x-amzn-waf-* request headers echoed back by the PHP origin).
#
# No exploit payload is sent. The strings PHPSESSID / PHP_SESSION_UPLOAD_PROGRESS
# are only the WAF rule's match conditions; upload progress is disabled on the origin.
#
# Requires: aws CLI, curl, jq, python3.
#
# Usage:
#   ./test-waf.sh --project PROJECT --env ENV [--suite SUITE]
#
# Examples:
#   ./test-waf.sh --project myproject --env dev
#   ./test-waf.sh --project myproject --env dev --suite offset
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
SUITE="all"
RATE_REQUESTS=150
CF_URL=""
ALB_URL=""
WORK_DIR=""

print_message() {
    echo -e "${1}${2}${NC}"
}

usage() {
    cat << EOF
Usage: $0 --project PROJECT --env ENV [OPTIONS]

Verify the PHP2Shell AWS WAF rules on CloudFront and on the ALB.

OPTIONS:
    -p, --project PROJECT     Project name (required)
    -e, --env ENV             Environment name, e.g. dev (required)
    --profile PROFILE         AWS CLI profile (default: <project>-<env>)
    --region REGION           Region of the main stack (default: ap-northeast-1)
    --suite SUITE             conditions | false-positive | offset | limits | ratelimit | all (default: all)
                              'all' runs everything except ratelimit
    --rate-requests N         POSTs sent by the ratelimit suite (default: 150)
    -h, --help                Show this help message

EXAMPLES:
    $0 --project myproject --env dev
    $0 --project myproject --env dev --suite ratelimit
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
            --suite) SUITE="$2"; shift 2 ;;
            --rate-requests) RATE_REQUESTS="$2"; shift 2 ;;
            -h|--help) usage ;;
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
    case "$SUITE" in
        conditions|false-positive|offset|limits|ratelimit|all) ;;
        *) print_message "$RED" "Unknown suite: $SUITE"; usage ;;
    esac
}

check_requirements() {
    local cmd
    for cmd in aws curl jq python3; do
        if ! command -v "$cmd" > /dev/null 2>&1; then
            print_message "$RED" "Required command not found: $cmd"
            exit 1
        fi
    done
}

aws_cmd() {
    aws --profile "$PROFILE" "$@"
}

verify_credentials() {
    if ! aws_cmd sts get-caller-identity > /dev/null 2>&1; then
        print_message "$RED" "Invalid AWS credentials for profile: $PROFILE"
        exit 1
    fi
}

load_endpoints() {
    local stack="${PROJECT}-${ENVIRONMENT}-waf-php2shell-mitigation"
    local outputs
    outputs=$(aws_cmd cloudformation describe-stacks --region "$REGION" --stack-name "$stack" \
        --query 'Stacks[0].Outputs' --output json)
    CF_URL=$(echo "$outputs" | jq -r '.[] | select(.OutputKey | startswith("CloudFrontUrl")) | .OutputValue')
    ALB_URL=$(echo "$outputs" | jq -r '.[] | select(.OutputKey | startswith("AlbUrl")) | .OutputValue')
    print_message "$BLUE" "CloudFront: $CF_URL"
    print_message "$BLUE" "ALB:        $ALB_URL"
}

url_for() {
    if [[ "$1" == "cf" ]]; then echo "$CF_URL"; else echo "$ALB_URL"; fi
}

print_header() {
    print_message "$YELLOW" "\n### $1"
    printf '| %-44s | %-4s | %-4s | %-26s | %s |\n' "case" "path" "http" "blocked-by" "counted"
    printf '|%s|%s|%s|%s|%s|\n' "----------------------------------------------" "------" "------" "----------------------------" "------"
}

# send CASE PATH_LABEL URL_PATH [curl args...]
send() {
    local name="$1" via="$2" path="$3"
    shift 3
    local headers="$WORK_DIR/headers" body="$WORK_DIR/body" code blocked counted
    code=$(curl -s -m 60 -o "$body" -D "$headers" -w '%{http_code}' "$@" "$(url_for "$via")${path}" || echo "ERR")
    blocked=$(grep -i '^x-php2shell-blocked-by:' "$headers" | awk '{print $2}' | tr -d '\r' || true)
    counted=$(jq -r '.wafHeaders // {} | keys | map(sub("x-amzn-waf-php2shell-"; "")) | join(",")' "$body" 2>/dev/null || true)
    printf '| %-44s | %-4s | %-4s | %-26s | %s |\n' "$name" "$via" "$code" "${blocked:--}" "${counted:--}"
}

# body_with_marker_end_at N FILE: urlencoded body whose PHP_SESSION_UPLOAD_PROGRESS ends at byte N
body_with_marker_end_at() {
    python3 -I -c '
import sys
n = int(sys.argv[1])
marker = "PHP_SESSION_UPLOAD_PROGRESS"
pad = n - len("p=") - len("&") - len(marker)
sys.stdout.write("p=" + "A" * pad + "&" + marker + "=1")
' "$1" > "$2"
}

# padded_body N FILE: urlencoded body of exactly N bytes with no rule strings
padded_body() {
    python3 -I -c 'import sys; n = int(sys.argv[1]); sys.stdout.write("p=" + "A" * (n - 2))' "$1" > "$2"
}

suite_conditions() {
    print_header "Rule conditions (reproduces the Classmethod ALB test, on both paths)"
    local via
    for via in cf alb; do
        send "POST cookie PHPSESSID + body PROGRESS" "$via" /upload -X POST -H 'Cookie: PHPSESSID=x' -d 'PHP_SESSION_UPLOAD_PROGRESS=1'
        send "POST body PHPSESSID + PROGRESS" "$via" /upload -X POST -d 'PHPSESSID=x&PHP_SESSION_UPLOAD_PROGRESS=1'
        send "POST cookies a=1; PHPSESSID=x + PROGRESS" "$via" /upload -X POST -H 'Cookie: a=1; PHPSESSID=x' -d 'PHP_SESSION_UPLOAD_PROGRESS=1'
        send "POST body PROGRESS only" "$via" /upload -X POST -d 'PHP_SESSION_UPLOAD_PROGRESS=1'
        send "POST cookie PHPSESSID only" "$via" /upload -X POST -H 'Cookie: PHPSESSID=x' -d 'a=b'
        send "PUT body PHPSESSID + PROGRESS" "$via" /upload -X PUT -d 'PHPSESSID=x&PHP_SESSION_UPLOAD_PROGRESS=1'
        send "POST multipart field PROGRESS + cookie" "$via" /upload -H 'Cookie: PHPSESSID=x' -F 'PHP_SESSION_UPLOAD_PROGRESS=1' -F 'f=@/etc/hostname'
        send "POST cookie phpsessid (lowercase key)" "$via" /upload -X POST -H 'Cookie: phpsessid=x' -d 'PHP_SESSION_UPLOAD_PROGRESS=1'
        send "POST body php_session_upload_progress" "$via" /upload -X POST -H 'Cookie: PHPSESSID=x' -d 'php_session_upload_progress=1'
    done
}

suite_false_positive() {
    print_header "Legitimate-looking requests (false positives / COUNT matches)"
    local via json="$WORK_DIR/json20k"
    python3 -I -c 'import json,sys; sys.stdout.write(json.dumps({"items": ["x" * 100] * 190}))' > "$json"
    for via in cf alb; do
        send "JSON body mentioning both strings" "$via" /api -X POST -H 'Cookie: PHPSESSID=x' -H 'Content-Type: application/json' \
            -d '{"note":"PHP_SESSION_UPLOAD_PROGRESS is disabled"}'
        send "text/plain body mentioning both strings" "$via" /api -X POST -H 'Content-Type: text/plain' \
            --data-binary 'PHPSESSID and PHP_SESSION_UPLOAD_PROGRESS'
        send "multipart file upload (normal)" "$via" /upload -F 'f=@/etc/hostname'
        send "Content-Type Multipart/Form-Data (mixed)" "$via" /upload -X POST -H 'Content-Type: Multipart/Form-Data; boundary=x' \
            --data-binary $'--x\r\nContent-Disposition: form-data; name="a"\r\n\r\nb\r\n--x--\r\n'
        send "JSON POST ~19 KB (no rule strings)" "$via" /api -X POST -H 'Content-Type: application/json' --data-binary "@$json"
    done
}

suite_offset() {
    print_header "Marker position vs body inspection limit (cookie PHPSESSID, PROGRESS ends at byte N)"
    local via n file
    for n in 8192 8193 16384 16385 32769 65536 65537 100000; do
        file="$WORK_DIR/marker-$n"
        body_with_marker_end_at "$n" "$file"
        for via in cf alb; do
            send "PROGRESS ends at byte $n" "$via" /upload -X POST -H 'Cookie: PHPSESSID=x' --data-binary "@$file"
        done
    done
}

suite_limits() {
    print_header "Body size limits beyond WAF (ALB -> Lambda payload, post_max_size)"
    local via n file
    for n in 1000000 1048576 1100000; do
        file="$WORK_DIR/pad-$n"
        padded_body "$n" "$file"
        for via in cf alb; do
            send "urlencoded body $n bytes" "$via" /upload -X POST --data-binary "@$file"
        done
    done
}

suite_ratelimit() {
    print_header "RateLimit-Posts (CloudFront only, $RATE_REQUESTS POSTs from one IP)"
    local i code counted first_counted="" started
    started=$(date +%s)
    for ((i = 1; i <= RATE_REQUESTS; i++)); do
        code=$(curl -s -m 30 -o "$WORK_DIR/rl" -D "$WORK_DIR/rlh" -w '%{http_code}' -X POST -d 'a=b' "${CF_URL}/form" || echo "ERR")
        counted=$(jq -r '.wafHeaders // {} | keys | join(",")' "$WORK_DIR/rl" 2>/dev/null || true)
        if [[ -z "$first_counted" && ( "$counted" == *ratelimit* || "$code" == "403" ) ]]; then
            first_counted="request #$i after $(( $(date +%s) - started ))s (http $code)"
        fi
        sleep 0.3
    done
    print_message "$GREEN" "RateLimit-Posts first matched at: ${first_counted:-never within $RATE_REQUESTS requests}"
    send "POST after the burst" cf /form -X POST -d 'a=b'
}

main() {
    parse_args "$@"
    validate_args
    check_requirements
    verify_credentials
    load_endpoints

    WORK_DIR=$(mktemp -d)
    trap 'rm -rf "$WORK_DIR"' EXIT

    case "$SUITE" in
        conditions) suite_conditions ;;
        false-positive) suite_false_positive ;;
        offset) suite_offset ;;
        limits) suite_limits ;;
        ratelimit) suite_ratelimit ;;
        all)
            suite_conditions
            suite_false_positive
            suite_offset
            suite_limits
            ;;
    esac
    print_message "$GREEN" "\nDone."
}

main "$@"
