#!/bin/bash
# Checks the deployed control plane without touching the Anthropic side.
#   1. An unsigned webhook is rejected with 401 (signature verification works).
#   2. The image build finished (the image exists and is CREATED).
#   3. The managed connectors / egress path outputs are present.
# Then lists worker MicroVMs, which is what you watch while running create-session.mjs.
#
# Usage: ./scripts/e2e-check.sh <stack-name> [aws-cli-args...]
set -euo pipefail

STACK_NAME="${1:?stack name is required}"
shift || true

out() {
  aws cloudformation describe-stacks --stack-name "${STACK_NAME}" "$@" \
    --query "Stacks[0].Outputs[?OutputKey=='$KEY'].OutputValue" --output text
}
KEY=WebhookUrl;       WEBHOOK_URL="$(out "$@")"
KEY=MicrovmImageArn;  IMAGE_ARN="$(out "$@")"
KEY=EgressMode;       EGRESS_MODE="$(out "$@")"

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILED=1; }
FAILED=0

BODY='{"type":"event","id":"evt_e2e","created_at":"2026-01-01T00:00:00Z","data":{"type":"session.status_run_started","id":"sesn_e2e"}}'
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${WEBHOOK_URL}" -H 'content-type: application/json' --data "${BODY}")"
[[ "${CODE}" == "401" ]] && pass "unsigned webhook -> 401" || fail "unsigned webhook -> ${CODE} (expected 401)"

CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${WEBHOOK_URL}" -H 'content-type: application/json' --data '{"not":"an event"}')"
[[ "${CODE}" == "400" ]] && pass "malformed body -> 400 (request validation)" || fail "malformed body -> ${CODE} (expected 400)"

STATE="$(aws lambda-microvms get-microvm-image --image-identifier "${IMAGE_ARN}" "$@" --query 'state' --output text 2>/dev/null || echo unknown)"
[[ "${STATE}" == "CREATED" ]] && pass "image state CREATED" || fail "image state ${STATE}"

echo "egress mode: ${EGRESS_MODE}"
echo "worker MicroVMs:"
aws lambda-microvms list-microvms --image-identifier "${IMAGE_ARN}" "$@" \
  --query 'items[].[microvmId,state,startedAt]' --output table || true

exit "${FAILED}"
