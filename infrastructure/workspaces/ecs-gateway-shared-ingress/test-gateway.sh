#!/bin/bash

#######################################
# test-gateway.sh
#
# Operational check for the ECS Gateway shared ingress architecture.
#
#   status   Gateways, cluster associations, gateway routes (status + URL) and
#            the ALBs each gateway manages (which routes share which ALB).
#   probe    Calls every route: PUBLIC URLs from this machine, PRIVATE URLs
#            from inside the VPC (probe Lambda), and shows that a PRIVATE
#            hostname resolves to private IPs and is unreachable from here.
#   canary   Forces a new deployment of the CANARY service and samples the
#            public URL with and without the gateway's test traffic header,
#            counting answers from the old and the new tasks over time.
#
# Requires: aws CLI v2 (2.38+ for the gateway commands), jq, curl, dig.
#
# Usage:
#   ./test-gateway.sh --project PROJECT --env ENV [status|probe|canary] [OPTIONS]
#
# Examples:
#   ./test-gateway.sh --project drillexercises --env dev status
#   ./test-gateway.sh --project drillexercises --env dev probe
#   ./test-gateway.sh --project drillexercises --env dev canary --service web
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
COMMAND="status"
CANARY_SERVICE="web"
SAMPLES=10
INTERVAL=15
TIMEOUT=1200
TEST_HEADER_NAME="x-test-traffic"
TEST_HEADER_VALUE="canary"

print_message() {
    echo -e "${1}${2}${NC}"
}

usage() {
    cat << EOF
Usage: $0 --project PROJECT --env ENV [status|probe|canary] [OPTIONS]

COMMANDS:
    status                       Gateways, associations, routes and managed ALBs (default)
    probe                        Call every gateway route (PUBLIC from here, PRIVATE via the probe Lambda)
    canary                       Force a deployment of --service and sample with/without the test header

OPTIONS:
    -p, --project PROJECT        Project name (required)
    -e, --env ENV                Environment name, e.g. dev (required)
    --profile PROFILE            AWS CLI profile (default: <project>-<env>)
    --region REGION              Region (default: ap-northeast-1)
    --service NAME               Service for 'canary' (default: web)
    --samples N                  Requests per sample and header variant (default: 10)
    --interval SECONDS           Seconds between samples (default: 15)
    --timeout SECONDS            Max seconds to follow the deployment (default: 1200)
    -h, --help                   Show this help message
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
            --service) CANARY_SERVICE="$2"; shift 2 ;;
            --samples) SAMPLES="$2"; shift 2 ;;
            --interval) INTERVAL="$2"; shift 2 ;;
            --timeout) TIMEOUT="$2"; shift 2 ;;
            status|probe|canary) COMMAND="$1"; shift ;;
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
    NAME_PREFIX="${PROJECT}-${ENVIRONMENT}-ecsgw"
    CLUSTER="${NAME_PREFIX}-cluster"
    GATEWAYS=("${NAME_PREFIX}-public" "${NAME_PREFIX}-private")
    PROBE_FUNCTION="${NAME_PREFIX}-probe"
}

check_requirements() {
    for cmd in aws jq curl dig; do
        if ! command -v "$cmd" > /dev/null 2>&1; then
            print_message "$RED" "Error: $cmd is required"
            exit 1
        fi
    done
    if ! aws ecs list-gateways help > /dev/null 2>&1; then
        print_message "$RED" "Error: this AWS CLI has no ECS gateway commands; update to 2.38 or later"
        exit 1
    fi
}

verify_credentials() {
    if ! aws_cmd sts get-caller-identity > /dev/null 2>&1; then
        print_message "$RED" "Error: cannot authenticate with profile ${PROFILE}"
        exit 1
    fi
}

aws_cmd() {
    aws --profile "$PROFILE" --region "$REGION" "$@"
}

# Prints "<route arn> <service name> <gateway name> <access type> <status> <url>" for every route.
list_routes() {
    local gateway access route_arns arn route
    for gateway in "${GATEWAYS[@]}"; do
        access=$(aws_cmd ecs describe-gateway --gateway "$gateway" --query 'gateway.accessType' --output text)
        route_arns=$(aws_cmd ecs list-gateway-routes --gateway "$gateway" --query 'gatewayRoutes[].gatewayRouteArn' --output text)
        for arn in $route_arns; do
            route=$(aws_cmd ecs describe-gateway-route --gateway-route-arn "$arn" --output json)
            echo "$arn $(jq -r '.gatewayRoute.serviceArn | split("/") | last' <<< "$route") $gateway $access \
$(jq -r '.gatewayRoute.status' <<< "$route") $(jq -r '.gatewayRoute.serviceUrl // "-"' <<< "$route")"
        done
    done
}

cmd_status() {
    print_message "$BLUE" "== Gateways"
    local gateway
    for gateway in "${GATEWAYS[@]}"; do
        aws_cmd ecs describe-gateway --gateway "$gateway" --output json | jq -r '.gateway | [
            .name, .accessType, .status,
            "ALBs \(.configuration.hostSharedAlb.currentAlbCount)/\(.configuration.hostSharedAlb.maxAlbCount)",
            "waf=\(if .configuration.hostSharedAlb.webACLArn then "yes" else "no" end)",
            "logs=\(if .configuration.hostSharedAlb.accessLogs then "yes" else "no" end)",
            "inboundSG=\(.configuration.hostSharedAlb.networkConfiguration.inboundSecurityGroup // "ecs-managed")"
          ] | @tsv'
    done | column -t

    print_message "$BLUE" "\n== Cluster associations"
    for gateway in "${GATEWAYS[@]}"; do
        aws_cmd ecs list-gateway-cluster-associations --gateway "$gateway" --output json |
            jq -r --arg g "$gateway" '.gatewayClusterAssociations[] | [$g, (.clusterArn | split("/") | last), .status] | @tsv'
    done | column -t

    print_message "$BLUE" "\n== Gateway routes"
    list_routes | awk '{print $2, $3, $4, $5, $6}' | column -t

    print_message "$BLUE" "\n== Managed ALBs and the routes they carry"
    for gateway in "${GATEWAYS[@]}"; do
        aws_cmd ecs describe-gateway-resources --gateway "$gateway" --output json |
            jq -r --arg g "$gateway" '.gatewayResources.resources.hostSharedAlb[]? |
                [$g, (.loadBalancerArn | split("/") | .[2]), "sg=\(.securityGroup)", "routes=\(.gatewayRouteArns | length)"] | @tsv'
    done | column -t
}

probe_public() {
    local service="$1" url="$2" status body
    body=$(curl -sS -m 10 -o - -w '\n%{http_code}' "$url/" 2>&1 || true)
    status=$(tail -n1 <<< "$body")
    print_message "$GREEN" "  [PUBLIC ] $service $url -> HTTP $status $(head -n1 <<< "$body")"
}

probe_private() {
    local service="$1" url="$2" host addresses result
    host="${url#https://}"
    addresses=$(dig +short "$host" | tr '\n' ' ')
    print_message "$YELLOW" "  [PRIVATE] $service $host resolves here to: ${addresses:-<none>}"
    if curl -sS -m 5 -o /dev/null "$url/" 2> /dev/null; then
        print_message "$RED" "  [PRIVATE] reachable from this machine (unexpected)"
    else
        print_message "$GREEN" "  [PRIVATE] not reachable from this machine (expected)"
    fi
    result=$(invoke_probe "{\"url\":\"$url/\"}")
    print_message "$GREEN" "  [PRIVATE] from the VPC: $(jq -c '{addresses, result: .results[0]}' <<< "$result")"
}

invoke_probe() {
    local out
    out=$(mktemp)
    aws_cmd lambda invoke --function-name "$PROBE_FUNCTION" --cli-binary-format raw-in-base64-out \
        --payload "$1" "$out" > /dev/null
    cat "$out"
    rm -f "$out"
}

cmd_probe() {
    print_message "$BLUE" "== Calling every gateway route"
    local arn service gateway access status url
    while read -r arn service gateway access status url; do
        if [ "$status" != "ACTIVE" ]; then
            print_message "$YELLOW" "  $service on $gateway is $status, skipped"
            continue
        fi
        if [ "$access" = "PUBLIC" ]; then
            probe_public "$service" "$url"
        else
            probe_private "$service" "$url"
        fi
    done < <(list_routes)

    print_message "$BLUE" "\n== Host-based routing: a public ALB answered with a hostname it does not route"
    local public_url alb_dns
    public_url=$(list_routes | awk '$4 == "PUBLIC" && $5 == "ACTIVE" {print $6; exit}')
    alb_dns=$(dig +short "${public_url#https://}" | head -n1)
    if [ -n "$alb_dns" ]; then
        curl -sk -m 10 -o /dev/null -w "  Host: unknown.example (via $alb_dns) -> HTTP %{http_code}\n" \
            --resolve "unknown.example:443:$alb_dns" https://unknown.example/ || true
    fi
}

cmd_canary() {
    local service_name="${NAME_PREFIX}-${CANARY_SERVICE}" url
    url=$(list_routes | awk -v s="$service_name" '$2 == s && $4 == "PUBLIC" {print $6; exit}')
    if [ -z "$url" ]; then
        print_message "$RED" "Error: no PUBLIC route for $service_name"
        exit 1
    fi
    print_message "$BLUE" "== Canary of $service_name ($url)"

    # Tasks answering before the deployment are "old"; anything else is the new revision.
    local before
    before=$(for _ in $(seq 1 20); do curl -s -m 5 "$url/" | jq -r '.task'; done | sort -u | tr '\n' ' ')
    print_message "$YELLOW" "  old tasks: $before"

    local deployment
    deployment=$(aws_cmd ecs update-service --cluster "$CLUSTER" --service "$service_name" --force-new-deployment \
        --query 'service.deployments[0].id' --output text)
    print_message "$YELLOW" "  started deployment $deployment"

    local start elapsed state plain_old plain_new test_old test_new task i
    start=$(date +%s)
    printf "  %-8s %-22s %-18s %-18s\n" "elapsed" "rollout" "no header old/new" "with header old/new"
    while true; do
        elapsed=$(( $(date +%s) - start ))
        state=$(aws_cmd ecs describe-services --cluster "$CLUSTER" --services "$service_name" \
            --query "services[0].deployments[?id=='$deployment'].rolloutState | [0]" --output text)
        plain_old=0; plain_new=0; test_old=0; test_new=0
        for i in $(seq 1 "$SAMPLES"); do
            task=$(curl -s -m 5 "$url/" | jq -r '.task' 2> /dev/null || echo "-")
            if [[ " $before " == *" $task "* ]]; then plain_old=$((plain_old + 1)); else plain_new=$((plain_new + 1)); fi
            task=$(curl -s -m 5 -H "$TEST_HEADER_NAME: $TEST_HEADER_VALUE" "$url/" | jq -r '.task' 2> /dev/null || echo "-")
            if [[ " $before " == *" $task "* ]]; then test_old=$((test_old + 1)); else test_new=$((test_new + 1)); fi
        done
        printf "  %-8s %-22s %-18s %-18s\n" "${elapsed}s" "$state" "$plain_old/$plain_new" "$test_old/$test_new"
        if [ "$state" = "COMPLETED" ] || [ "$state" = "FAILED" ] || [ "$elapsed" -ge "$TIMEOUT" ]; then
            break
        fi
        sleep "$INTERVAL"
    done
}

main() {
    parse_args "$@"
    validate_args
    check_requirements
    verify_credentials
    case "$COMMAND" in
        status) cmd_status ;;
        probe) cmd_probe ;;
        canary) cmd_canary ;;
    esac
}

main "$@"
