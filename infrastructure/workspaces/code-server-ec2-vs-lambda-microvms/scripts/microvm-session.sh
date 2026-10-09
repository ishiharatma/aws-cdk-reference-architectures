#!/bin/bash
# Operate the code-server MicroVM: start | connect | status | stop.
#
# Usage:
#   ./scripts/microvm-session.sh start   [--profile P] [--stack NAME]
#   ./scripts/microvm-session.sh connect [--profile P] [--port 8443]
#   ./scripts/microvm-session.sh status  [--profile P]
#   ./scripts/microvm-session.sh stop    [--profile P]
# Defaults: --stack ${PROJECT}-${ENV:-dev}-code-server-microvms (PROJECT must be set unless --stack is given), --profile from AWS_PROFILE.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
STATE_FILE="${SCRIPT_DIR}/.session.json"

print_message() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }

COMMAND="${1:-}"; shift || true
STACK="${PROJECT:-project}-${ENV:-dev}-code-server-microvms"
PORT=8443
IDLE_SECONDS=900
MAX_SECONDS=14400
PROFILE_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE_ARGS=(--profile "$2"); PROFILE="$2"; shift 2 ;;
    --stack) STACK="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --idle-seconds) IDLE_SECONDS="$2"; shift 2 ;;
    --max-seconds) MAX_SECONDS="$2"; shift 2 ;;
    *) print_message 31 "Unknown option: $1"; exit 2 ;;
  esac
done
PROFILE="${PROFILE:-${AWS_PROFILE:-}}"

check_requirements() {
  for c in aws jq node curl; do command -v "$c" >/dev/null || { print_message 31 "$c is required"; exit 1; }; done
}
aws_cmd() { aws "${PROFILE_ARGS[@]}" "$@"; }
stack_output() {
  aws_cmd cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
state() { jq -r "$1" "$STATE_FILE"; }

cmd_start() {
  local image role egress started log_group
  image=$(stack_output MicrovmImageArn); role=$(stack_output MicrovmExecutionRoleArn)
  egress=$(stack_output InternetEgressConnectorArn); log_group=$(stack_output LogGroupName)
  started=$(date +%s)
  print_message 36 "Launching a MicroVM from ${image}"
  aws_cmd lambda-microvms run-microvm \
    --image-identifier "$image" \
    --execution-role-arn "$role" \
    --egress-network-connectors "$egress" \
    --logging "{\"cloudWatch\":{\"logGroup\":\"${log_group}\"}}" \
    --idle-policy "{\"autoResumeEnabled\":true,\"maxIdleDurationSeconds\":${IDLE_SECONDS},\"suspendedDurationSeconds\":3600}" \
    --maximum-duration-in-seconds "$MAX_SECONDS" \
    --output json > "$STATE_FILE"
  jq '{microvmId, endpoint, state}' "$STATE_FILE"
  local id endpoint token
  id=$(state .microvmId); endpoint=$(state .endpoint)
  token=$(aws_cmd lambda-microvms create-microvm-auth-token --microvm-identifier "$id" \
    --expiration-in-minutes 10 --allowed-ports '[{"allPorts":{}}]' --query 'authToken."X-aws-proxy-auth"' --output text)
  print_message 36 "Waiting for code-server to answer /healthz ..."
  for _ in $(seq 1 120); do
    if curl -fsS -o /dev/null -H "X-aws-proxy-auth: ${token}" "https://${endpoint#https://}/healthz" 2>/dev/null; then
      print_message 32 "Ready in $(( $(date +%s) - started )) s after run-microvm was called."
      return
    fi
    sleep 1
  done
  print_message 31 "code-server did not become healthy within 120 s"; exit 1
}

cmd_connect() {
  [[ -f "$STATE_FILE" ]] || { print_message 31 "No session. Run 'start' first."; exit 1; }
  local secret
  secret=$(stack_output PasswordSecretName)
  print_message 36 "Password:  aws secretsmanager get-secret-value --secret-id ${secret} --query SecretString --output text ${PROFILE:+--profile $PROFILE}"
  print_message 32 "Open: http://localhost:${PORT}   (Ctrl-C to stop the relay)"
  exec node "${SCRIPT_DIR}/relay.mjs" --microvm-id "$(state .microvmId)" --endpoint "$(state .endpoint)" \
    --port "$PORT" ${PROFILE:+--profile "$PROFILE"}
}

cmd_status() {
  [[ -f "$STATE_FILE" ]] || { print_message 31 "No session."; exit 1; }
  aws_cmd lambda-microvms get-microvm --microvm-identifier "$(state .microvmId)" --query '{state:state,endpoint:endpoint}' --output json
}

cmd_stop() {
  [[ -f "$STATE_FILE" ]] || { print_message 31 "No session."; exit 1; }
  aws_cmd lambda-microvms terminate-microvm --microvm-identifier "$(state .microvmId)"
  rm -f "$STATE_FILE"
  print_message 32 "Terminated."
}

check_requirements
case "$COMMAND" in
  start) cmd_start ;; connect) cmd_connect ;; status) cmd_status ;; stop) cmd_stop ;;
  *) sed -n 2,9p "$0"; exit 2 ;;
esac
