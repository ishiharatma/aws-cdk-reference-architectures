#!/usr/bin/env bash
# End-to-end check of the API Gateway -> VPC link -> internal ALB -> Fargate path.
# Usage: ./test-api.sh --project <project> --env <env> [--region <region>]
set -euo pipefail

PROJECT="" ENVIRONMENT="" REGION="${AWS_REGION:-ap-northeast-1}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --env) ENVIRONMENT="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$PROJECT" && -n "$ENVIRONMENT" ]] || { echo "Usage: $0 --project <project> --env <env> [--region <region>]" >&2; exit 2; }

for cmd in aws curl jq; do command -v "$cmd" >/dev/null || { echo "$cmd is required" >&2; exit 1; }; done
export AWS_PROFILE="${AWS_PROFILE:-${PROJECT}-${ENVIRONMENT}}"
STACK="${PROJECT}-${ENVIRONMENT}-apigw-vpclink-private-alb"

out() { aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
pass() { printf '\033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

API_URL="$(out ApiUrl)"; API_URL="${API_URL%/}"
KEY_ID="$(out ApiKeyId)"
ALB_DNS="$(out AlbDnsName)"
API_KEY="$(aws apigateway get-api-key --api-key "$KEY_ID" --include-value --region "$REGION" --query value --output text)"
echo "API: $API_URL"

# 1. No API key -> rejected by API Gateway before reaching the VPC link
code="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/")"
[[ "$code" == "403" ]] && pass "no API key -> 403" || fail "no API key -> $code (expected 403)"

# 2. With API key -> served by a Fargate task through the VPC link
body="$(curl -s -w '\n%{http_code}' -H "x-api-key: $API_KEY" "$API_URL/")"
code="${body##*$'\n'}"; json="${body%$'\n'*}"
if [[ "$code" == "200" ]] && jq -e '.service == "backend"' <<<"$json" >/dev/null; then
  pass "API key -> 200 from backend task $(jq -r .task <<<"$json")"
else fail "API key -> $code: $json"; fi

# 3. Proxy path is forwarded (the stock nginx answers 404 for unknown paths, which proves the path reached it)
code="$(curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: $API_KEY" "$API_URL/does-not-exist")"
[[ "$code" == "404" ]] && pass "proxy path forwarded (backend 404)" || fail "unknown path -> $code (expected backend 404)"

# 4. Both tasks answer: load is spread across targets
tasks="$(for _ in $(seq 1 12); do curl -s -H "x-api-key: $API_KEY" "$API_URL/" | jq -r .task; sleep 0.3; done | sort -u | wc -l)"
[[ "$tasks" -ge 2 ]] && pass "$tasks distinct tasks served requests" || fail "only $tasks task(s) served requests"

# 5. The ALB cannot be reached from the internet: internal scheme, DNS resolves to private IPs only
scheme="$(aws elbv2 describe-load-balancers --region "$REGION" --query "LoadBalancers[?DNSName=='$ALB_DNS'].Scheme" --output text)"
[[ "$scheme" == "internal" ]] && pass "ALB scheme is internal" || fail "ALB scheme is '$scheme'"
if curl -s -m 5 -o /dev/null "http://$ALB_DNS/"; then fail "ALB answered from outside the VPC"; else pass "ALB unreachable from outside the VPC"; fi

# 6. Throttling: a burst above the usage plan limit gets 429
codes="$(for _ in $(seq 1 60); do curl -s -o /dev/null -w '%{http_code}\n' -H "x-api-key: $API_KEY" "$API_URL/" & done; wait)"
n429="$(grep -c '^429$' <<<"$codes" || true)"
[[ "$n429" -gt 0 ]] && pass "burst of 60 -> $n429 throttled (429)" || fail "no request was throttled in a burst of 60"

exit "$FAILED"
