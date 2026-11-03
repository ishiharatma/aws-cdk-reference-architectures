#!/bin/bash

#######################################
# test-vpn.sh
#
# Operational check for the three remote-access VPN methods.
# Drives the client simulator (an EC2 instance in an unrelated VPC) through SSM Run Command:
#
#   status   Readiness of each method: Client VPN endpoint / associations, the self-hosted
#            servers' services, and the client simulator's SSM status.
#   run      For each method: connect as client1 (allowed) and client2 (denied), report
#            connect time, ping RTT, HTTP throughput, MTU and the source IP the target saw.
#   logs     How each method recorded the attempts above: Client VPN connection log and
#            connect-handler decisions, OpenVPN server.log, WireGuard peer log.
#
# Requires: aws CLI v2, jq.
#
# Usage:
#   ./test-vpn.sh --project PROJECT --env ENV [status|run|logs] [OPTIONS]
#
# Examples:
#   ./test-vpn.sh --project drillexercises --env dev status
#   ./test-vpn.sh --project drillexercises --env dev run --methods "wireguard openvpn" --mb 50
#   ./test-vpn.sh --project drillexercises --env dev logs --since 30m
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
METHODS="client-vpn openvpn wireguard"
CLIENTS="client1 client2"
BLOB_MB=100
RUNS=3
SINCE="60m"

print_message() {
    echo -e "${1}${2}${NC}"
}

usage() {
    cat << EOF
Usage: $0 --project PROJECT --env ENV [status|run|logs] [OPTIONS]

COMMANDS:
    status                 Readiness of the three methods and the client simulator (default)
    run                    Connect with every method as client1 and client2 and measure
    logs                   What each method logged about the connection attempts

OPTIONS:
    -p, --project PROJECT  Project name (required)
    -e, --env ENV          Environment name, e.g. dev (required)
    --profile PROFILE      AWS CLI profile (default: <project>-<env>)
    --region REGION        Region (default: ap-northeast-1)
    --methods "A B"        Methods for 'run' (default: "client-vpn openvpn wireguard")
    --clients "A B"        Clients for 'run' (default: "client1 client2")
    --mb N                 Download size per throughput run in MiB (default: 100)
    --runs N               Throughput runs per method (default: 3)
    --since DURATION       Window for 'logs', e.g. 30m, 2h (default: 60m)
    -h, --help             Show this help
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
            --methods) METHODS="$2"; shift 2 ;;
            --clients) CLIENTS="$2"; shift 2 ;;
            --mb) BLOB_MB="$2"; shift 2 ;;
            --runs) RUNS="$2"; shift 2 ;;
            --since) SINCE="$2"; shift 2 ;;
            status|run|logs) COMMAND="$1"; shift ;;
            -h|--help) usage ;;
            *) print_message "$RED" "Unknown argument: $1"; usage ;;
        esac
    done
}

validate_args() {
    if [[ -z "$PROJECT" || -z "$ENVIRONMENT" ]]; then
        print_message "$RED" "--project and --env are required"
        usage
    fi
    PROFILE="${PROFILE:-${PROJECT}-${ENVIRONMENT}}"
    PREFIX="/${PROJECT}/${ENVIRONMENT}/vpn"
    STACK_PREFIX="${PROJECT}-${ENVIRONMENT}-vpn"
}

check_requirements() {
    for cmd in aws jq; do
        command -v "$cmd" > /dev/null || { print_message "$RED" "$cmd is required"; exit 1; }
    done
}

aws_cmd() {
    aws --profile "$PROFILE" --region "$REGION" "$@"
}

verify_credentials() {
    local account
    account=$(aws_cmd sts get-caller-identity --query Account --output text) || {
        print_message "$RED" "Cannot get credentials for profile $PROFILE"; exit 1; }
    print_message "$BLUE" "Account: $account  Region: $REGION  Prefix: $PREFIX"
}

stack_output() {
    aws_cmd cloudformation describe-stacks --stack-name "$1" \
        --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null
}

param() {
    aws_cmd ssm get-parameter --name "$PREFIX/$1" --query Parameter.Value --output text 2>/dev/null
}

# Runs a shell command on an instance via SSM and prints its stdout (waits up to $3 seconds).
ssm_run() {
    local instance=$1 script=$2 timeout=${3:-600} command_id status
    command_id=$(aws_cmd ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
        --timeout-seconds "$timeout" \
        --parameters "$(jq -n --arg c "$script" --arg t "$timeout" '{commands: [$c], executionTimeout: [$t]}')" \
        --query Command.CommandId --output text)
    for _ in $(seq 1 $((timeout / 5 + 6))); do
        sleep 5
        status=$(aws_cmd ssm get-command-invocation --command-id "$command_id" --instance-id "$instance" \
            --query Status --output text 2>/dev/null || echo Pending)
        case $status in Success|Failed|TimedOut|Cancelled) break ;; esac
    done
    aws_cmd ssm get-command-invocation --command-id "$command_id" --instance-id "$instance" \
        --query StandardOutputContent --output text
    [[ "$status" == Success ]] || print_message "$YELLOW" "  (command status: $status)"
}

cmd_status() {
    local endpoint sim
    print_message "$BLUE" "== Client VPN"
    endpoint=$(param client-vpn/endpoint-id || true)
    if [[ -n "$endpoint" ]]; then
        aws_cmd ec2 describe-client-vpn-endpoints --client-vpn-endpoint-ids "$endpoint" \
            --query 'ClientVpnEndpoints[0].{id:ClientVpnEndpointId,status:Status.Code,dns:DnsName,cidr:ClientCidrBlock,split:SplitTunnel}' --output table
        aws_cmd ec2 describe-client-vpn-target-networks --client-vpn-endpoint-id "$endpoint" \
            --query 'ClientVpnTargetNetworks[].{subnet:TargetNetworkId,status:Status.Code}' --output table
    else
        print_message "$YELLOW" "  not deployed"
    fi

    for method in openvpn wireguard; do
        local stack instance service
        print_message "$BLUE" "== $method"
        stack="${STACK_PREFIX}-${method}"
        instance=$(stack_output "$stack" "$([[ $method == openvpn ]] && echo OpenVpnInstanceId || echo WireGuardInstanceId)")
        if [[ -z "$instance" ]]; then print_message "$YELLOW" "  not deployed"; continue; fi
        service=$([[ $method == openvpn ]] && echo openvpn-server@server || echo wg-quick@wg0)
        echo "  instance=$instance public_ip=$(param "$method/public-ip")"
        ssm_run "$instance" "cloud-init status; systemctl is-active $service; $([[ $method == wireguard ]] && echo 'wg show wg0 | head -20' || echo 'tail -n 3 /var/log/openvpn/server.log')" 120 | sed 's/^/  /'
    done

    print_message "$BLUE" "== client simulator"
    sim=$(stack_output "${STACK_PREFIX}-client-sim" ClientSimulatorInstanceId)
    if [[ -z "$sim" ]]; then print_message "$YELLOW" "  not deployed"; return; fi
    ssm_run "$sim" "cloud-init status; command -v vpn-test openvpn wg" 120 | sed 's/^/  /'
}

cmd_run() {
    local sim results=()
    sim=$(stack_output "${STACK_PREFIX}-client-sim" ClientSimulatorInstanceId)
    [[ -n "$sim" ]] || { print_message "$RED" "client simulator stack not deployed"; exit 1; }
    for method in $METHODS; do
        for client in $CLIENTS; do
            print_message "$BLUE" "== $method / $client"
            local out
            out=$(ssm_run "$sim" "vpn-test $method $client $BLOB_MB $RUNS" 900)
            echo "$out" | sed 's/^/  /'
            results+=("$(echo "$out" | grep '^RESULT' || echo "RESULT method=$method client=$client status=no-result")")
        done
    done
    print_message "$GREEN" "== summary"
    printf '%s\n' "${results[@]}"
}

since_ms() {
    local value=${SINCE%[mh]} unit=${SINCE: -1} seconds
    if [[ $unit == h ]]; then seconds=$((value * 3600)); else seconds=$((value * 60)); fi
    echo $(( ($(date +%s) - seconds) * 1000 ))
}

log_group_of() {
    aws_cmd cloudformation describe-stack-resources --stack-name "$1" \
        --query "StackResources[?ResourceType=='AWS::Logs::LogGroup' && contains(LogicalResourceId, '$2')].PhysicalResourceId" \
        --output text
}

print_events() {
    local group=$1 filter=${2:-}
    aws_cmd logs filter-log-events --log-group-name "$group" --start-time "$(since_ms)" \
        ${filter:+--filter-pattern "$filter"} --query 'events[].message' --output text | tr '\t' '\n' | tail -n 40
}

cmd_logs() {
    local group
    print_message "$BLUE" "== Client VPN connection log (status / common name / source)"
    group=$(log_group_of "${STACK_PREFIX}-client-vpn" ConnectionLogGroup)
    [[ -n "$group" ]] && aws_cmd logs filter-log-events --log-group-name "$group" --start-time "$(since_ms)" \
        --query 'events[].message' --output text | tr '\t' '\n' | \
        jq -r '[."connection-attempt-status", ."connection-attempt-failure-reason", ."common-name", ."client-ip", ."connection-start-time", ."connection-end-time", ."ingress-bytes", ."egress-bytes"] | @tsv' 2>/dev/null | tail -n 20
    print_message "$BLUE" "== Client VPN connect handler decisions"
    group=$(log_group_of "${STACK_PREFIX}-client-vpn" ConnectHandlerLogGroup)
    [[ -n "$group" ]] && print_events "$group" '{ $.decision = * }'
    print_message "$BLUE" "== OpenVPN server.log (connections, TLS failures)"
    group=$(log_group_of "${STACK_PREFIX}-openvpn" ServerLogGroup)
    [[ -n "$group" ]] && print_events "$group" '?"Peer Connection Initiated" ?"VERIFY ERROR" ?"TLS Error" ?"client-instance exiting" ?"Inactivity timeout" ?"CRL"'
    print_message "$BLUE" "== WireGuard peer log (handshake age per peer, per minute)"
    group=$(log_group_of "${STACK_PREFIX}-wireguard" ServerLogGroup)
    [[ -n "$group" ]] && print_events "$group"
}

main() {
    parse_args "$@"
    validate_args
    check_requirements
    verify_credentials
    case $COMMAND in
        status) cmd_status ;;
        run) cmd_run ;;
        logs) cmd_logs ;;
    esac
}

main "$@"
