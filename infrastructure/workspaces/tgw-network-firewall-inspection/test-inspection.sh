#!/usr/bin/env bash
# End-to-end check of the centralized inspection path, run from the spoke instances through SSM.
# Usage: ./test-inspection.sh --project <project> --env <env> [--region <region>]
set -euo pipefail

PROJECT="" ENVIRONMENT="" REGION="${AWS_REGION:-ap-northeast-1}" BLOCKED_DOMAIN="example.com" ALLOWED_URL="https://checkip.amazonaws.com"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --env) ENVIRONMENT="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --blocked-domain) BLOCKED_DOMAIN="$2"; shift 2 ;;
    --allowed-url) ALLOWED_URL="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$PROJECT" && -n "$ENVIRONMENT" ]] || { echo "Usage: $0 --project <project> --env <env> [--region <region>]" >&2; exit 2; }
for cmd in aws jq; do command -v "$cmd" >/dev/null || { echo "$cmd is required" >&2; exit 1; }; done

export AWS_PROFILE="${AWS_PROFILE:-${PROJECT}-${ENVIRONMENT}}"
STACK="${PROJECT}-${ENVIRONMENT}-tgw-network-firewall-inspection"
FAILED=0
pass() { printf '\033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
out() { aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

CLIENT="$(out ClientInstanceId)"; SERVER="$(out ServerInstanceId)"; SERVER_IP="$(out ServerPrivateIp)"; ALERT_LOGS="$(out AlertLogGroup)"

# run_on <instance-id> <shell command>: prints "<exit-code>|<stdout>" of the command run through SSM
run_on() {
  local id cmd_id status
  id="$(aws ssm send-command --instance-ids "$1" --document-name AWS-RunShellScript --region "$REGION" \
    --parameters "commands=[\"$2\"]" --query Command.CommandId --output text)"
  for _ in $(seq 1 40); do
    status="$(aws ssm get-command-invocation --command-id "$id" --instance-id "$1" --region "$REGION" --query Status --output text 2>/dev/null || echo Pending)"
    case "$status" in Success|Failed|TimedOut|Cancelled) break ;; esac
    sleep 3
  done
  aws ssm get-command-invocation --command-id "$id" --instance-id "$1" --region "$REGION" \
    --query '[ResponseCode, StandardOutputContent]' --output text | tr '\t' '|' | tr -d '\n'
}

echo "stack: $STACK  client: $CLIENT  server: $SERVER ($SERVER_IP)"

# 0. Both instances must register with SSM, which already proves the egress path (spoke -> TGW -> firewall -> NAT) works
for id in "$CLIENT" "$SERVER"; do
  online=""
  for _ in $(seq 1 60); do
    online="$(aws ssm describe-instance-information --region "$REGION" --filters "Key=InstanceIds,Values=$id" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
    [[ "$online" == "Online" ]] && break; sleep 10
  done
  [[ "$online" == "Online" ]] && pass "$id registered with SSM through the inspected egress path" || fail "$id never became SSM-managed"
done

# 1. Allowed domain over the internet path
r="$(run_on "$CLIENT" "curl -sS -m 15 -o /dev/null -w '%{http_code}' $ALLOWED_URL")"
[[ "${r%%|*}" == "0" && "$r" == *"|200" ]] && pass "allowed domain ($ALLOWED_URL) -> HTTP 200" || fail "allowed domain failed: $r"

# 2. Domain outside the allow list is dropped
r="$(run_on "$CLIENT" "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://$BLOCKED_DOMAIN")"
[[ "${r%%|*}" != "0" ]] && pass "domain outside the allow list ($BLOCKED_DOMAIN) is blocked: ${r%%|*}" || fail "$BLOCKED_DOMAIN was reachable: $r"

# 3. East-west TCP between the spokes is allowed (and inspected)
r="$(run_on "$CLIENT" "curl -sS -m 10 http://$SERVER_IP:8080/")"
[[ "$r" == *"spoke-b"* ]] && pass "east-west HTTP spoke A -> spoke B works" || fail "east-west HTTP failed: $r"

# 4. East-west ICMP is dropped by the firewall (the security group allows it)
r="$(run_on "$CLIENT" "ping -c 3 -W 2 $SERVER_IP")"
[[ "${r%%|*}" == "1" ]] && pass "east-west ICMP spoke A -> spoke B is dropped (100% loss)" || fail "east-west ICMP was not dropped: ${r:0:120}"

# 5. The firewall logged the drops
found_domain=0; found_icmp=0
for _ in $(seq 1 24); do
  events="$(aws logs filter-log-events --log-group-name "$ALERT_LOGS" --region "$REGION" --filter-pattern '"blocked"' --query 'events[].message' --output text 2>/dev/null || true)"
  grep -q "$BLOCKED_DOMAIN" <<<"$events" && found_domain=1
  grep -qi "icmp" <<<"$events" && found_icmp=1
  [[ $found_domain -eq 1 && $found_icmp -eq 1 ]] && break; sleep 10
done
[[ $found_domain -eq 1 ]] && pass "alert log records the blocked domain" || fail "no alert log entry for $BLOCKED_DOMAIN"
[[ $found_icmp -eq 1 ]] && pass "alert log records the blocked east-west ICMP" || fail "no alert log entry for ICMP"

exit "$FAILED"
