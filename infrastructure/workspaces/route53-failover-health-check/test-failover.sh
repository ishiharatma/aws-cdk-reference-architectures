#!/usr/bin/env bash
# End-to-end check of Route 53 failover: take the primary down, watch DNS switch to the secondary, bring it back.
# Usage: ./test-failover.sh --project <project> --env <env> [--region <region>] [--timeout <seconds>]
set -euo pipefail

PROJECT="" ENVIRONMENT="" REGION="${AWS_REGION:-ap-northeast-1}" TIMEOUT=180
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --env) ENVIRONMENT="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$PROJECT" && -n "$ENVIRONMENT" ]] || { echo "Usage: $0 --project <project> --env <env> [--region <region>] [--timeout <seconds>]" >&2; exit 2; }

for cmd in aws curl jq; do command -v "$cmd" >/dev/null || { echo "$cmd is required" >&2; exit 1; }; done
export AWS_PROFILE="${AWS_PROFILE:-${PROJECT}-${ENVIRONMENT}}"
STACK="${PROJECT}-${ENVIRONMENT}-route53-failover-health-check"
FAILED=0

out() { aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
pass() { printf '\033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }

RECORD="$(out RecordName)"; HC_ID="$(out HealthCheckId)"
FN="$(out PrimaryFunctionName)"; PRIMARY_URL="$(out PrimaryUrl)"; SECONDARY_URL="$(out SecondaryUrl)"
host_of() { sed -E 's#https://([^/]+)/?#\1#' <<<"$1"; }
PRIMARY_HOST="$(host_of "$PRIMARY_URL")"; SECONDARY_HOST="$(host_of "$SECONDARY_URL")"

RESOLVER="$(out ResolverFunctionName)"
RESPONSE_FILE="$(mktemp)"
answer() { # resolve the record inside the VPC through the resolver Lambda
  aws lambda invoke --function-name "$RESOLVER" --region "$REGION" --cli-binary-format raw-in-base64-out \
    --payload '{}' "$RESPONSE_FILE" >/dev/null 2>&1 && jq -r '.cname[0] // "unresolved"' "$RESPONSE_FILE" | sed 's/\.$//' || echo unresolved
}
role_of() { curl -s -m 5 "https://$1/" | jq -r .role; }
set_fail() { # $1 = true|false
  aws lambda update-function-configuration --function-name "$FN" --region "$REGION" \
    --environment "Variables={ROLE=primary,FAIL=$1}" >/dev/null
  aws lambda wait function-updated --function-name "$FN" --region "$REGION"
}
wait_for() { # $1 = expected host, $2 = label; prints elapsed seconds
  local start=$SECONDS
  while (( SECONDS - start < TIMEOUT )); do
    [[ "$(answer)" == "$1" ]] && { echo $(( SECONDS - start )); return 0; }
    sleep 3
  done
  return 1
}
trap 'rm -f "$RESPONSE_FILE"; set_fail false >/dev/null 2>&1 || true' EXIT

echo "record: $RECORD  health check: $HC_ID"

# 0. Let a fresh health check report healthy
set_fail false
if t="$(wait_for "$PRIMARY_HOST" primary)"; then pass "initial answer is the primary (after ${t}s)"; else fail "answer never became the primary"; fi
[[ "$(role_of "$PRIMARY_HOST")" == "primary" ]] && pass "primary endpoint serves role=primary" || fail "primary endpoint did not answer"

# 1. Break the primary: /health returns 503
set_fail true
[[ "$(curl -s -o /dev/null -w '%{http_code}' "https://$PRIMARY_HOST/health")" == "503" ]] && pass "primary /health now returns 503"
if t="$(wait_for "$SECONDARY_HOST" secondary)"; then pass "DNS failed over to the secondary in ${t}s"; else fail "DNS did not fail over within ${TIMEOUT}s"; fi
[[ "$(role_of "$SECONDARY_HOST")" == "secondary" ]] && pass "secondary endpoint serves role=secondary" || fail "secondary endpoint did not answer"

# 2. Restore the primary: DNS fails back
set_fail false
if t="$(wait_for "$PRIMARY_HOST" primary)"; then pass "DNS failed back to the primary in ${t}s"; else fail "DNS did not fail back within ${TIMEOUT}s"; fi

exit "$FAILED"
