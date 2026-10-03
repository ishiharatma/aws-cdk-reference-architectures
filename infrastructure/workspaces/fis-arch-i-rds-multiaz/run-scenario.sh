#!/bin/bash
# Usage: ./run-scenario.sh <I-1|I-2|I-3> [--project drillexercises] [--env dev] [--profile <p>] [--region <r>]
# Starts the failover probe Lambda, waits for it to settle, starts the FIS experiment
# for the scenario, then prints the probe's measured outage windows.
set -euo pipefail

SCENARIO="${1:?scenario required (I-1|I-2|I-3)}"; shift || true
PROJECT=drillexercises; ENV_NAME=dev; PROFILE=""; REGION=ap-northeast-1
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2;;
    --env) ENV_NAME="$2"; shift 2;;
    --profile) PROFILE="$2"; shift 2;;
    --region) REGION="$2"; shift 2;;
    *) echo "unknown arg $1"; exit 1;;
  esac
done
AWS=(aws --region "$REGION"); [ -n "$PROFILE" ] && AWS+=(--profile "$PROFILE")

DURATION=${PROBE_SECONDS:-420}   # total probe time
LEAD=${LEAD_SECONDS:-45}         # healthy baseline before the fault is injected
OUT=$(mktemp)

TEMPLATE_ID=$("${AWS[@]}" fis list-experiment-templates \
  --query "experimentTemplates[?tags.Scenario=='${SCENARIO}' && tags.Name!=null && contains(tags.Name,'${PROJECT}-${ENV_NAME}-')].id | [0]" --output text)
[ "$TEMPLATE_ID" = "None" ] && { echo "template for $SCENARIO not found"; exit 1; }

echo "[$(date +%T)] starting probe (${DURATION}s)"
"${AWS[@]}" lambda invoke --function-name "${PROJECT}-${ENV_NAME}-db-probe" \
  --cli-binary-format raw-in-base64-out --cli-read-timeout 0 \
  --payload "{\"durationSeconds\":${DURATION}}" "$OUT" >/dev/null &
PROBE_PID=$!

sleep "$LEAD"
echo "[$(date +%T)] starting FIS experiment ($TEMPLATE_ID, $SCENARIO)"
EXP=$("${AWS[@]}" fis start-experiment --experiment-template-id "$TEMPLATE_ID" --query 'experiment.id' --output text)
echo "experiment: $EXP"

wait "$PROBE_PID"
"${AWS[@]}" fis get-experiment --id "$EXP" --query 'experiment.{status:state.status,reason:state.reason}' --output json
jq . "$OUT"
