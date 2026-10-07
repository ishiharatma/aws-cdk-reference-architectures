#!/bin/bash
# Start (create), stop (delete) or check the on-demand SFTP server (manual / scheduled mode).
# A stopped Transfer Family server is still billed, so stop deletes it and start creates a new one.
# The server ID and the default host name change on every start; the host key stays the same only when
# the stack was deployed with a host key secret (serverLifecycle.hostKeySecretArn).
# Usage: control-transfer-server.sh (start|stop|status) [--wait] [--function NAME]
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

ACTION="${1:-}"; shift || true
FUNCTION_NAME="${SFTP_CONTROLLER_FUNCTION:-}" WAIT=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait) WAIT=true; shift ;;
    --function) FUNCTION_NAME="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
require_tools
[[ "$ACTION" =~ ^(start|stop|status)$ ]] || die "action must be start, stop or status"
[[ -n "$FUNCTION_NAME" ]] || die "controller function name is required (--function or SFTP_CONTROLLER_FUNCTION)"

invoke() {
  local out; out="$(mktemp)"
  aws lambda invoke --function-name "$FUNCTION_NAME" --cli-binary-format raw-in-base64-out \
    --payload "{\"action\":\"$1\"}" "$out" --query FunctionError --output text >"$out.err"
  [[ "$(cat "$out.err")" == "None" ]] || { cat "$out" >&2; rm -f "$out" "$out.err"; die "controller function failed"; }
  cat "$out"; rm -f "$out" "$out.err"
}

RESULT="$(invoke "$ACTION")"
echo "$RESULT" | jq .
if [[ "$WAIT" == true && "$ACTION" == start ]]; then
  for _ in $(seq 1 40); do
    RESULT="$(invoke status)"
    [[ "$(jq -r .state <<<"$RESULT")" == ONLINE ]] && break
    sleep 10
  done
  echo "$RESULT" | jq .
  [[ "$(jq -r .state <<<"$RESULT")" == ONLINE ]] || die "server did not become ONLINE in time"
fi
