#!/bin/bash

#######################################
# test-spot.sh
#
# Operational check for the FARGATE / FARGATE_SPOT mixed service.
#
#   status     Service settings (strategy, AZ rebalancing) and every task with
#              its AZ, capacity provider and ALB target state, plus an
#              AZ x capacity provider matrix.
#   traffic    Sends requests to the ALB and counts answers per AZ and task.
#   drain      Stops one task (FARGATE_SPOT if any) while sending requests,
#              and follows the target state, the SIGTERM the application
#              logged, and failed requests: the same path a Spot interruption
#              takes, minus the 2-minute warning.
#   rebalance  Simulates an AZ impairment: occupies every free IP of one AZ's
#              private subnet with temporary ENIs, scales the service out so
#              the new tasks can only land in the other AZs, releases the IPs,
#              scales back in, and measures how long AZ rebalancing takes to
#              balance every capacity provider again (it starts ~15 minutes
#              after the steady state). Desired count, scaling minimum and
#              ENIs are restored on exit. (Stopping the tasks of the AZ does
#              not empty it: the replacements reuse the released IPs.)
#   events     Recent stopped tasks (stop code / reason), Spot interruption
#              warnings, and service actions recorded by EventBridge.
#
# Requires: aws CLI v2, jq, curl.
#
# Usage:
#   ./test-spot.sh --project PROJECT --env ENV [status|traffic|drain|rebalance|events] [OPTIONS]
#
# Examples:
#   ./test-spot.sh --project drillexercises --env dev status
#   ./test-spot.sh --project drillexercises --env dev drain
#   ./test-spot.sh --project drillexercises --env dev rebalance --az ap-northeast-1c
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
REQUESTS=60
TARGET_AZ=""
TIMEOUT=1800
SCALE_OUT=3
ENI_TAG="fgspot-rebalance-test"
CREATED_ENIS=()

print_message() {
    echo -e "${1}${2}${NC}"
}

usage() {
    cat << EOF
Usage: $0 --project PROJECT --env ENV [status|traffic|drain|rebalance|events] [OPTIONS]

COMMANDS:
    status                       Service settings, tasks and the AZ x capacity provider matrix (default)
    traffic                      Send --requests requests to the ALB and count answers per AZ and task
    drain                        Stop one task under load and follow deregistration, SIGTERM and errors
    rebalance                    Simulate an AZ impairment and measure AZ rebalancing (~20 minutes)
    events                       Recorded stopped tasks, Spot interruptions and service actions

OPTIONS:
    -p, --project PROJECT        Project name (required)
    -e, --env ENV                Environment name, e.g. dev (required)
    --profile PROFILE            AWS CLI profile (default: <project>-<env>)
    --region REGION              Region (default: ap-northeast-1)
    --requests N                 Requests for 'traffic' (default: 60)
    --az AZ                      AZ to impair for 'rebalance' (default: the AZ with the fewest tasks)
    --scale-out N                Tasks added while the AZ is impaired (default: 3)
    --timeout SECONDS            Max seconds to wait in each 'rebalance' phase (default: 1800)
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
            --requests) REQUESTS="$2"; shift 2 ;;
            --az) TARGET_AZ="$2"; shift 2 ;;
            --timeout) TIMEOUT="$2"; shift 2 ;;
            --scale-out) SCALE_OUT="$2"; shift 2 ;;
            status|traffic|drain|rebalance|events) COMMAND="$1"; shift ;;
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
    STACK_NAME="${PROJECT}-${ENVIRONMENT}-ecs-fargate-spot"
}

check_requirements() {
    for cmd in aws jq curl; do
        if ! command -v "$cmd" > /dev/null 2>&1; then
            print_message "$RED" "Error: $cmd is required"
            exit 1
        fi
    done
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

load_outputs() {
    local outputs
    outputs=$(aws_cmd cloudformation describe-stacks --stack-name "$STACK_NAME" --query 'Stacks[0].Outputs' --output json)
    output() { jq -r --arg k "$1" '.[] | select(.OutputKey == $k) | .OutputValue' <<< "$outputs"; }
    ALB_URL=$(output AlbUrl)
    CLUSTER=$(output ClusterName)
    SERVICE=$(output ServiceName)
    TARGET_GROUP=$(output TargetGroupArn)
    APP_LOG_GROUP=$(output AppLogGroup)
    SPOT_LOG_GROUP=$(output SpotInterruptionLogGroup)
    STOPPED_LOG_GROUP=$(output TaskStoppedLogGroup)
    ACTION_LOG_GROUP=$(output ServiceActionLogGroup)
}

now() {
    date +%s.%N | cut -c1-14
}

# JSON array of the service's RUNNING and PENDING tasks: id, az, provider, status, ip.
service_tasks() {
    local arns
    arns=$(aws_cmd ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --query 'taskArns' --output text)
    if [ -z "$arns" ] || [ "$arns" == "None" ]; then
        echo '[]'
        return
    fi
    # shellcheck disable=SC2086
    aws_cmd ecs describe-tasks --cluster "$CLUSTER" --tasks $arns --output json | jq '[.tasks[] | {
        id: (.taskArn | split("/") | last),
        az: .availabilityZone,
        provider: (.capacityProviderName // "-"),
        status: .lastStatus,
        startedAt: (.startedAt // "-"),
        ip: ([.attachments[]?.details[]? | select(.name == "privateIPv4Address") | .value] | first // "-")
      }] | sort_by(.az, .provider)'
}

target_states() {
    aws_cmd elbv2 describe-target-health --target-group-arn "$TARGET_GROUP" --output json |
        jq '[.TargetHealthDescriptions[] | {key: .Target.Id, value: .TargetHealth.State}] | from_entries'
}

# Prints "AZ  FARGATE  FARGATE_SPOT  total" for RUNNING tasks.
print_matrix() {
    jq -r '[.[] | select(.status == "RUNNING")] as $t
        | ($t | map(.az) | unique) as $azs
        | (["AZ", "FARGATE", "FARGATE_SPOT", "total"] | @tsv),
          ($azs[] as $az | [$az,
            ($t | map(select(.az == $az and .provider == "FARGATE")) | length),
            ($t | map(select(.az == $az and .provider == "FARGATE_SPOT")) | length),
            ($t | map(select(.az == $az)) | length)] | @tsv),
          (["total",
            ($t | map(select(.provider == "FARGATE")) | length),
            ($t | map(select(.provider == "FARGATE_SPOT")) | length),
            ($t | length)] | @tsv)' <<< "$1" | column -t
}

cmd_status() {
    print_message "$BLUE" "== Service ${SERVICE}"
    aws_cmd ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json | jq -r '.services[0] |
        "desired=\(.desiredCount) running=\(.runningCount) pending=\(.pendingCount)",
        "availabilityZoneRebalancing=\(.availabilityZoneRebalancing // "<not returned>")",
        "strategy=\(.capacityProviderStrategy | map("\(.capacityProvider)(base=\(.base // 0),weight=\(.weight))") | join(" "))",
        "deployment min/max=\(.deploymentConfiguration.minimumHealthyPercent)/\(.deploymentConfiguration.maximumPercent)%"'

    local tasks targets
    tasks=$(service_tasks)
    targets=$(target_states)
    print_message "$BLUE" "\n== Tasks"
    jq -r --argjson tg "$targets" '(["TASK", "AZ", "PROVIDER", "STATUS", "IP", "TARGET"] | @tsv),
        (.[] | [.id[0:12], .az, .provider, .status, .ip, ($tg[.ip] // "-")] | @tsv)' <<< "$tasks" | column -t

    print_message "$BLUE" "\n== RUNNING tasks per AZ and capacity provider"
    print_matrix "$tasks"
}

cmd_traffic() {
    print_message "$BLUE" "== ${REQUESTS} requests to ${ALB_URL}"
    local i out
    out=$(mktemp)
    for ((i = 0; i < REQUESTS; i++)); do
        curl -sS -m 5 "$ALB_URL/" >> "$out" 2> /dev/null || echo '{"az":"ERROR","taskId":"ERROR"}' >> "$out"
        echo >> "$out"
    done
    print_message "$GREEN" "Answers per AZ:"
    jq -sr 'map(select(. != null)) | group_by(.az)[] | "  \(.[0].az)\t\(length)"' "$out"
    print_message "$GREEN" "Answers per task:"
    jq -sr 'map(select(. != null)) | group_by(.taskId)[] | "  \(.[0].taskId[0:12])\t\(.[0].az)\t\(length)"' "$out"
    rm -f "$out"
}

cmd_drain() {
    local tasks task task_id ip load_pid load_out t0 state last_state="" elapsed task_status
    tasks=$(service_tasks)
    task=$(jq -c '[.[] | select(.status == "RUNNING")] | (map(select(.provider == "FARGATE_SPOT")) + .) | first' <<< "$tasks")
    if [ "$task" == "null" ]; then
        print_message "$RED" "No RUNNING task"
        exit 1
    fi
    task_id=$(jq -r .id <<< "$task")
    ip=$(jq -r .ip <<< "$task")
    print_message "$BLUE" "== Stopping ${task_id} ($(jq -r '"\(.provider) in \(.az), \(.ip)"' <<< "$task")) under load"

    load_out=$(mktemp)
    (
        local end=$(($(date +%s) + 150))
        while [ "$(date +%s)" -lt "$end" ]; do
            curl -s -m 5 -o /dev/null -w '%{http_code}\n' "$ALB_URL/" >> "$load_out" || echo "000" >> "$load_out"
            sleep 0.2
        done
    ) &
    load_pid=$!
    sleep 3

    t0=$(now)
    aws_cmd ecs stop-task --cluster "$CLUSTER" --task "$task_id" --reason "test-spot.sh drain check" > /dev/null
    print_message "$YELLOW" "StopTask sent at $(date -d "@${t0}" +%T.%3N)"

    while true; do
        elapsed=$(awk -v a="$(now)" -v b="$t0" 'BEGIN { printf "%.1f", a - b }')
        state=$(target_states | jq -r --arg ip "$ip" '.[$ip] // "gone"')
        task_status=$(aws_cmd ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_id" --query 'tasks[0].lastStatus' --output text)
        if [ "$state/$task_status" != "$last_state" ]; then
            echo "  +${elapsed}s target=${state} task=${task_status}"
            last_state="$state/$task_status"
        fi
        if [ "$task_status" == "STOPPED" ]; then
            break
        fi
        sleep 1
    done

    wait "$load_pid" || true
    print_message "$BLUE" "\n== What the application logged"
    aws_cmd logs get-log-events --log-group-name "$APP_LOG_GROUP" --log-stream-name "app/App/${task_id}" \
        --output json | jq -r --arg t0 "$t0" '.events[].message | fromjson? | select(.event == "SIGTERM" or .event == "EXIT")
            | "  \(.event) at +\(((.ts - ($t0 | tonumber)) * 10 | round) / 10)s after StopTask"'
    aws_cmd ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_id" --output json |
        jq -r '.tasks[0] | "  stopCode=\(.stopCode) reason=\(.stoppedReason)"'

    print_message "$BLUE" "\n== Requests during the check"
    sort "$load_out" | uniq -c | awk '{ printf "  HTTP %s: %s\n", $2, $1 }'
    rm -f "$load_out"
}

# Prints RUNNING counts per AZ as "az=total(F/S)": F = FARGATE, S = FARGATE_SPOT.
az_counts() {
    jq -r '[.[] | select(.status == "RUNNING")] | group_by(.az)
        | map("\(.[0].az | sub("^.*-"; ""))=\(length)(\(map(select(.provider == "FARGATE")) | length)/\(map(select(.provider == "FARGATE_SPOT")) | length))")
        | join(" ")' <<< "$1"
}

cleanup_enis() {
    local eni
    for eni in "${CREATED_ENIS[@]}"; do
        aws_cmd ec2 delete-network-interface --network-interface-id "$eni" > /dev/null 2>&1 &&
            print_message "$YELLOW" "Deleted temporary ENI ${eni}"
    done
    CREATED_ENIS=()
}

# Creates ENIs with secondary IPs until the subnet has no free address left.
occupy_subnet() {
    local subnet="$1" free count eni
    while true; do
        free=$(aws_cmd ec2 describe-subnets --subnet-ids "$subnet" --query 'Subnets[0].AvailableIpAddressCount' --output text)
        if [ "$free" -le 0 ]; then
            break
        fi
        # One primary address plus up to 49 secondary addresses per ENI.
        count=$((free > 50 ? 49 : free - 1))
        if [ "$count" -gt 0 ]; then
            eni=$(aws_cmd ec2 create-network-interface --subnet-id "$subnet" --secondary-private-ip-address-count "$count" \
                --description "$ENI_TAG" --query 'NetworkInterface.NetworkInterfaceId' --output text)
        else
            eni=$(aws_cmd ec2 create-network-interface --subnet-id "$subnet" \
                --description "$ENI_TAG" --query 'NetworkInterface.NetworkInterfaceId' --output text)
        fi
        CREATED_ENIS+=("$eni")
    done
    print_message "$YELLOW" "Occupied every free IP of ${subnet} with ${#CREATED_ENIS[@]} temporary ENIs"
}

restore_capacity() {
    if [ -n "${ORIGINAL_MIN:-}" ]; then
        aws_cmd application-autoscaling register-scalable-target --service-namespace ecs \
            --scalable-dimension ecs:service:DesiredCount --resource-id "service/${CLUSTER}/${SERVICE}" \
            --min-capacity "$ORIGINAL_MIN" > /dev/null
        aws_cmd ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count "$ORIGINAL_DESIRED" > /dev/null
        print_message "$YELLOW" "Restored desired count ${ORIGINAL_DESIRED} and scaling minimum ${ORIGINAL_MIN}"
        ORIGINAL_MIN=""
    fi
}

# Waits until RUNNING tasks reach $1 and, when $2 is "balanced", every capacity provider is balanced
# on its own (each AZ holds floor..ceil of that provider's tasks / AZ count). That is what ECS
# evaluates: FARGATE and FARGATE_SPOT are spread independently, and a total of 4/2/3 made of
# FARGATE 2/1/1 + FARGATE_SPOT 2/1/2 was left alone for 30 minutes.
wait_for_tasks() {
    local want="$1" mode="$2" since="$3" tasks elapsed azs last=""
    azs=$(aws_cmd ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
        --query 'length(services[0].networkConfiguration.awsvpcConfiguration.subnets)' --output text)
    while true; do
        tasks=$(service_tasks)
        elapsed=$(awk -v a="$(now)" -v b="$since" 'BEGIN { printf "%.0f", a - b }')
        if [ "$(az_counts "$tasks")" != "$last" ]; then
            last=$(az_counts "$tasks")
            echo "  +${elapsed}s ${last}"
        fi
        if jq -e --argjson n "$want" --argjson azs "$azs" --arg mode "$mode" '
                [.[] | select(.status == "RUNNING")] as $t
                | ($t | length == $n) and ($mode != "balanced" or
                    ($t | group_by(.provider) | all(
                        length as $p | (($p / $azs) | floor) as $low | (($p / $azs) | ceil) as $high
                        | ([group_by(.az)[] | length] | (length == ([$p, $azs] | min)) and all(. >= $low and . <= $high))
                    )))' <<< "$tasks" > /dev/null; then
            WAITED="$elapsed"
            LAST_TASKS="$tasks"
            return 0
        fi
        if [ "$elapsed" -gt "$TIMEOUT" ]; then
            print_message "$RED" "Timed out after ${TIMEOUT}s"
            LAST_TASKS="$tasks"
            return 1
        fi
        sleep 15
    done
}

cmd_rebalance() {
    local tasks subnets subnet target t_start t_scale_in
    tasks=$(service_tasks)
    ORIGINAL_DESIRED=$(aws_cmd ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
        --query 'services[0].desiredCount' --output text)
    target=$((ORIGINAL_DESIRED + SCALE_OUT))
    if [ -z "$TARGET_AZ" ]; then
        TARGET_AZ=$(jq -r '[.[] | select(.status == "RUNNING")] | group_by(.az) | min_by(length) | .[0].az' <<< "$tasks")
    fi
    subnets=$(aws_cmd ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
        --query 'services[0].networkConfiguration.awsvpcConfiguration.subnets' --output text)
    # shellcheck disable=SC2086
    subnet=$(aws_cmd ec2 describe-subnets --subnet-ids $subnets \
        --query "Subnets[?AvailabilityZone=='${TARGET_AZ}'].SubnetId | [0]" --output text)
    print_message "$BLUE" "== Impairing ${TARGET_AZ} (${subnet}), then scaling ${ORIGINAL_DESIRED} -> ${target}"
    echo "  before: $(az_counts "$tasks")"

    trap 'cleanup_enis; restore_capacity' EXIT
    # Existing tasks keep their IPs; only new tasks find the AZ full.
    occupy_subnet "$subnet"

    ORIGINAL_MIN=$(aws_cmd application-autoscaling describe-scalable-targets --service-namespace ecs \
        --resource-ids "service/${CLUSTER}/${SERVICE}" --query 'ScalableTargets[0].MinCapacity' --output text)
    # Raise the scaling minimum too, or target tracking could scale the extra tasks back in.
    aws_cmd application-autoscaling register-scalable-target --service-namespace ecs \
        --scalable-dimension ecs:service:DesiredCount --resource-id "service/${CLUSTER}/${SERVICE}" \
        --min-capacity "$target" > /dev/null
    t_start=$(now)
    aws_cmd ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count "$target" > /dev/null
    print_message "$YELLOW" "Scaled out while ${TARGET_AZ} has no free IP"
    wait_for_tasks "$target" any "$t_start" || true
    print_message "$GREEN" "${target} tasks RUNNING after ${WAITED:-?}s"
    print_matrix "$LAST_TASKS"

    cleanup_enis
    print_message "$YELLOW" "\nReleased the IPs of ${TARGET_AZ}"
    if wait_for_tasks "$target" balanced "$(now)"; then
        print_message "$YELLOW" "Each capacity provider is balanced on its own, so ECS does not rebalance this total"
    fi

    # Scale-in stops tasks in the AZ with the most tasks in total, regardless of the provider,
    # which leaves one provider unbalanced: that is the state AZ rebalancing corrects.
    restore_capacity
    t_scale_in=$(now)
    wait_for_tasks "$ORIGINAL_DESIRED" any "$t_scale_in" || true
    aws_cmd ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" || true
    print_message "$YELLOW" "Scaled back in to ${ORIGINAL_DESIRED} and reached a steady state; waiting for AZ rebalancing"
    print_matrix "$LAST_TASKS"
    if wait_for_tasks "$ORIGINAL_DESIRED" balanced "$t_scale_in"; then
        print_message "$GREEN" "Every capacity provider balanced ${WAITED}s after the scale-in"
    fi
    print_matrix "$LAST_TASKS"

    print_message "$BLUE" "\n== Latest service events"
    aws_cmd ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json |
        jq -r '.services[0].events[:15][] | "  \(.createdAt[11:19]) \(.message)"' | tac
}

cmd_events() {
    local since
    since=$(( ($(date +%s) - 6 * 3600) * 1000 ))
    print_message "$BLUE" "== Stopped tasks (last 6 hours)"
    aws_cmd logs filter-log-events --log-group-name "$STOPPED_LOG_GROUP" --start-time "$since" --output json |
        jq -r '.events[].message | fromjson | .detail | [(.stoppedAt // "-"), (.taskArn | split("/") | last | .[0:12]),
            .availabilityZone, (.capacityProviderName // "-"), .stopCode, .stoppedReason] | @tsv' | column -t -s $'\t'

    print_message "$BLUE" "\n== Spot interruption warnings (last 6 hours)"
    aws_cmd logs filter-log-events --log-group-name "$SPOT_LOG_GROUP" --start-time "$since" --output json |
        jq -r '.events | if length == 0 then "  none" else .[].message | fromjson | .detail
            | "  \(.stoppingAt // .updatedAt) \(.taskArn | split("/") | last) \(.availabilityZone)" end'

    print_message "$BLUE" "\n== Service actions (last 6 hours)"
    aws_cmd logs filter-log-events --log-group-name "$ACTION_LOG_GROUP" --start-time "$since" --output json |
        jq -r '.events | if length == 0 then "  none" else .[].message | fromjson
            | "  \(.time) \(.detail.eventName) \(.detail.reason // "")" end'
}

main() {
    parse_args "$@"
    validate_args
    check_requirements
    verify_credentials
    load_outputs
    case "$COMMAND" in
        status) cmd_status ;;
        traffic) cmd_traffic ;;
        drain) cmd_drain ;;
        rebalance) cmd_rebalance ;;
        events) cmd_events ;;
    esac
}

main "$@"
