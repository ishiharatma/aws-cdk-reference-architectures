#!/usr/bin/env bash
# Runs the same four deployments through native ECS blue/green and through CodeDeploy, in parallel, and compares them:
#   1. a good release (v2)                              -> traffic moves, no request fails, the test listener showed v2 first
#   2. a release whose lifecycle hook fails (v3)        -> automatic rollback, production stays on v2
#   3. a good release (v4), rolled back during the bake -> how fast production returns to v2
#   4. a broken release (v5: the container exits)       -> does the platform give up by itself? (capped, then stopped)
# A probe sends 5 requests per second to the production URL the whole time and counts failures.
# Usage: ./test-deployments.sh --project <project> --env <env> [--region <region>] [--only native|codedeploy]
set -euo pipefail

PROJECT="" ENVIRONMENT="" REGION="${AWS_REGION:-ap-northeast-1}" ONLY="both" BROKEN_CAP=420
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --env) ENVIRONMENT="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --broken-cap) BROKEN_CAP="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$PROJECT" && -n "$ENVIRONMENT" ]] || { echo "Usage: $0 --project <project> --env <env> [--region <region>] [--only native|codedeploy]" >&2; exit 2; }
for cmd in aws curl jq; do command -v "$cmd" >/dev/null || { echo "$cmd is required" >&2; exit 1; }; done

export AWS_PROFILE="${AWS_PROFILE:-${PROJECT}-${ENVIRONMENT}}" AWS_DEFAULT_REGION="$REGION"
STACK="${PROJECT}-${ENVIRONMENT}-ecs-blue-green-native-vs-codedeploy"
WORK="$(mktemp -d)"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; for p in "${VERDICT[@]}"; do aws ssm put-parameter --name "$p" --value pass --overwrite >/dev/null 2>&1 || true; done; if [[ "${FAILED:-0}" == 0 ]]; then rm -rf "$WORK"; else echo "logs kept in $WORK" >&2; fi; }
trap cleanup EXIT
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

CLUSTER="$(out ClusterName)"; HOOK_FN="$(out HookFunctionName)"
declare -A VERDICT
VERDICT[native]="$(out NativeHookVerdictParameter)"; VERDICT[codedeploy]="$(out CodeDeployHookVerdictParameter)"
CD_APP="$(out CodeDeployApplicationName)"; CD_GROUP="$(out CodeDeployGroupName)"
declare -A PROD TEST FAMILY SERVICE
PROD[native]="$(out NativeUrl)"; TEST[native]="$(out NativeTestUrl)"; FAMILY[native]="$(out NativeTaskFamily)"; SERVICE[native]="$(out NativeServiceName)"
PROD[codedeploy]="$(out CodeDeployUrl)"; TEST[codedeploy]="$(out CodeDeployTestUrl)"; FAMILY[codedeploy]="$(out CodeDeployTaskFamily)"; SERVICE[codedeploy]="$(out CodeDeployServiceName)"
for p in "${VERDICT[@]}"; do aws ssm put-parameter --name "$p" --value pass --overwrite >/dev/null; done
echo "stack: $STACK  cluster: $CLUSTER"

# ------------------------------------------------------------------------------------------------------------------
# helpers (everything takes the flavor as $1: native | codedeploy)
# ------------------------------------------------------------------------------------------------------------------
now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.0f", b - a }'; }
version_of() { curl -s -m 3 "$1/" 2>/dev/null | jq -r '.version // "-"' 2>/dev/null || echo "-"; }

# probe <flavor>: 5 requests per second to the production URL; "<epoch> <http-code> <version>" per line
probe_start() {
  local f="$1" log="$WORK/probe-$1.log"
  ( while :; do
      t="$(now)"; r="$(curl -s -m 2 -w '\n%{http_code}' "${PROD[$f]}/" 2>/dev/null || printf '\n000')"
      echo "$t ${r##*$'\n'} $(jq -r '.version // "-"' <<<"${r%$'\n'*}" 2>/dev/null || echo -)" >> "$log"
      sleep 0.2
    done ) &
  PIDS+=("$!")
  PROBE_PID="$!"
}

# new_revision <flavor> <version> <break>: registers a task definition revision of the flavor's family and prints its ARN
new_revision() {
  local f="$1" version="$2" brk="$3"
  aws ecs describe-task-definition --task-definition "${FAMILY[$f]}" --query taskDefinition --output json \
    | jq --arg v "$version" --arg b "$brk" 'del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy)
        | .containerDefinitions[0].environment |= (map(if .name=="VERSION" then .value=$v elif .name=="BREAK" then .value=$b else . end))' > "$WORK/td-$f.json"
  aws ecs register-task-definition --cli-input-json "file://$WORK/td-$f.json" --query taskDefinition.taskDefinitionArn --output text
}

# deploy <flavor> <version> <break>: starts a deployment and sets DEPLOY_ID
deploy() {
  local f="$1" arn; arn="$(new_revision "$1" "$2" "$3")"
  if [[ "$f" == native ]]; then
    local previous; previous="$(aws ecs list-service-deployments --cluster "$CLUSTER" --service "${SERVICE[$f]}" --query 'serviceDeployments[0].serviceDeploymentArn' --output text)"
    aws ecs update-service --cluster "$CLUSTER" --service "${SERVICE[$f]}" --task-definition "$arn" >/dev/null
    # the new deployment appears in the list a moment later: wait for it, or the previous (finished) one would be watched
    for _ in $(seq 1 30); do
      DEPLOY_ID="$(aws ecs list-service-deployments --cluster "$CLUSTER" --service "${SERVICE[$f]}" --query 'serviceDeployments[0].serviceDeploymentArn' --output text)"
      [[ "$DEPLOY_ID" != "$previous" ]] && break; sleep 1
    done
  else
    local spec; spec="$(jq -nc --arg td "$arn" --arg hook "$HOOK_FN" '{version:0.0,Resources:[{TargetService:{Type:"AWS::ECS::Service",Properties:{TaskDefinition:$td,LoadBalancerInfo:{ContainerName:"app",ContainerPort:80}}}}],Hooks:[{AfterAllowTestTraffic:$hook}]}')"
    DEPLOY_ID="$(aws deploy create-deployment --application-name "$CD_APP" --deployment-group-name "$CD_GROUP" \
      --revision "$(jq -nc --arg c "$spec" '{revisionType:"AppSpecContent",appSpecContent:{content:$c}}')" --query deploymentId --output text)"
  fi
}

# state <flavor>: sets STATE (RUNNING | SUCCEEDED | FAILED, where FAILED means stopped or rolled back) and STATE_DETAIL.
# It must not run in a subshell, or the two variables are lost.
state() {
  local f="$1" s
  if [[ "$f" == native ]]; then
    s="$(aws ecs describe-service-deployments --service-deployment-arns "$DEPLOY_ID" --query 'serviceDeployments[0].[status,lifecycleStage]' --output text)"
    STATE_DETAIL="${s//$'\t'/ / }"
    case "${s%%$'\t'*}" in SUCCESSFUL) STATE=SUCCEEDED ;; ROLLBACK_SUCCESSFUL|ROLLBACK_FAILED|STOPPED) STATE=FAILED ;; *) STATE=RUNNING ;; esac
  else
    s="$(aws deploy get-deployment --deployment-id "$DEPLOY_ID" --query 'deploymentInfo.status' --output text)"
    STATE_DETAIL="$s"
    case "$s" in Succeeded) STATE=SUCCEEDED ;; Failed|Stopped) STATE=FAILED ;; *) STATE=RUNNING ;; esac
  fi
}

# rollback_now <flavor>
rollback_now() {
  if [[ "$1" == native ]]; then aws ecs stop-service-deployment --service-deployment-arn "$DEPLOY_ID" --stop-type ROLLBACK >/dev/null
  else aws deploy stop-deployment --deployment-id "$DEPLOY_ID" --auto-rollback-enabled >/dev/null; fi
}

# wait_for <flavor> <seconds>: polls until the deployment ends (or the cap); records the window in which the test listener
# already answers with the new version while production still answers with the old one. Sets WAIT_RESULT and WINDOW.
wait_for() {
  local f="$1" cap="$2" new="${3:-}" old="${4:-}" start; start="$(now)"; WINDOW="no"; FIRST_PROD_NEW=""
  while (( $(since "$start") < cap )); do
    state "$f"; local st="$STATE"
    if [[ -n "$new" ]]; then
      local tv pv; tv="$(version_of "${TEST[$f]}")"; pv="$(version_of "${PROD[$f]}")"
      [[ "$tv" == "$new" && "$pv" == "$old" ]] && WINDOW="yes"
      [[ "$pv" == "$new" && -z "$FIRST_PROD_NEW" ]] && FIRST_PROD_NEW="$(since "$start")"
    fi
    [[ "$st" != RUNNING ]] && { WAIT_RESULT="$st"; WAIT_SECONDS="$(since "$start")"; return 0; }
    sleep 2
  done
  WAIT_RESULT="TIMEOUT"; WAIT_SECONDS="$(since "$start")"
}

# after a failure CodeDeploy runs a rollback deployment of its own: wait for it
wait_rollback_done() {
  local f="$1"
  [[ "$f" == codedeploy ]] || { sleep 5; return; }
  local rb start; start="$(now)"
  rb="$(aws deploy get-deployment --deployment-id "$DEPLOY_ID" --query 'deploymentInfo.rollbackInfo.rollbackDeploymentId' --output text)"
  [[ "$rb" == None || -z "$rb" ]] && return
  while (( $(since "$start") < 600 )); do
    [[ "$(aws deploy get-deployment --deployment-id "$rb" --query deploymentInfo.status --output text)" =~ ^(Succeeded|Failed|Stopped)$ ]] && return; sleep 4
  done
}

wait_prod() { # <flavor> <version> <seconds>: waits until production answers with the version; prints elapsed seconds or fails
  local f="$1" s; s="$(now)"
  while (( $(since "$s") < $3 )); do [[ "$(version_of "${PROD[$f]}")" == "$2" ]] && { since "$s"; return 0; }; sleep 1; done
  return 1
}

# ------------------------------------------------------------------------------------------------------------------
# the four scenarios for one flavor; results are appended to $WORK/result-<flavor>.jsonl
# ------------------------------------------------------------------------------------------------------------------
record() { jq -nc --arg f "$FLAVOR" --arg k "$1" --argjson v "$2" '{flavor:$f,check:$k,data:$v}' >> "$WORK/result-$FLAVOR.jsonl"; }

run_flavor() {
  set +e   # a failing step must not end the run: the report says which one failed
  FLAVOR="$1"; local f="$1"
  # start every run from v1, whatever an earlier run left behind
  if [[ "$(version_of "${PROD[$f]}")" != v1 ]]; then deploy "$f" v1 false; wait_for "$f" 900; wait_rollback_done "$f"; wait_prod "$f" v1 120 >/dev/null; fi
  probe_start "$f"
  sleep 3
  [[ "$(version_of "${PROD[$f]}")" == v1 ]] || { record baseline '{"ok":false}'; return; }

  # 1. a good release
  local t0; t0="$(now)"; deploy "$f" v2 false; wait_for "$f" 900 v2 v1
  record good_release "$(jq -nc --arg r "$WAIT_RESULT" --arg w "$WINDOW" --argjson total "$WAIT_SECONDS" --argjson shift "${FIRST_PROD_NEW:-null}" --arg now "$(version_of "${PROD[$f]}")" '{result:$r,testListenerShowedNewFirst:($w=="yes"),secondsToProductionSwitch:$shift,secondsToDeploymentEnd:$total,productionVersion:$now}')"

  # 2. the lifecycle hook says no
  aws ssm put-parameter --name "${VERDICT[$f]}" --value fail --overwrite >/dev/null
  deploy "$f" v3 false; wait_for "$f" 600 v3 v2; wait_rollback_done "$f"
  record hook_fails "$(jq -nc --arg r "$WAIT_RESULT" --arg d "$STATE_DETAIL" --arg pv "$(version_of "${PROD[$f]}")" --argjson s "$WAIT_SECONDS" '{result:$r,detail:$d,secondsToGiveUp:$s,productionVersion:$pv}')"
  aws ssm put-parameter --name "${VERDICT[$f]}" --value pass --overwrite >/dev/null

  # 3. a good release, then rolled back while the old version is still kept
  deploy "$f" v4 false
  local sw; sw="$(wait_prod "$f" v4 600 || echo -1)"
  local r0; r0="$(now)"; rollback_now "$f"
  local back; back="$(wait_prod "$f" v2 300 || echo -1)"
  wait_for "$f" 300; wait_rollback_done "$f"
  record rollback_in_bake "$(jq -nc --argjson sw "$sw" --argjson back "$back" --arg pv "$(version_of "${PROD[$f]}")" '{secondsUntilProductionServedV4:$sw,secondsFromRollbackToV2:$back,productionVersion:$pv}')"

  # 4. a release whose container exits: does the platform give up on its own?
  deploy "$f" v5 true; wait_for "$f" "$BROKEN_CAP" v5 v2
  local gave_up="no"; [[ "$WAIT_RESULT" == FAILED ]] && gave_up="yes"
  local secs="$WAIT_SECONDS"
  if [[ "$WAIT_RESULT" == TIMEOUT ]]; then rollback_now "$f" || true; wait_for "$f" 300; fi
  wait_rollback_done "$f"
  record broken_release "$(jq -nc --arg g "$gave_up" --argjson s "$secs" --arg pv "$(version_of "${PROD[$f]}")" '{gaveUpByItself:($g=="yes"),secondsObserved:$s,productionVersion:$pv}')"

  sleep 3
  kill "$PROBE_PID" 2>/dev/null || true
  # What the probe saw over the whole run. An HTTP error (a response that is not 200) is a failed request. "No response" (curl
  # code 000: a timeout or a dropped connection) is counted separately, because it also happens in steady state from a laptop or
  # a dev container; what matters is whether it clusters around a version change, so the ones within 2 s of one are counted too.
  awk '{ n++; t[n]=$1; c[n]=$2; v[n]=$3 }
       END {
         for (i = 2; i <= n; i++) if (v[i] != "-" && v[i-1] != "-" && v[i] != v[i-1]) change[++k] = t[i]
         for (i = 1; i <= n; i++) {
           if (c[i] == "000") { none++; for (j = 1; j <= k; j++) if (t[i] - change[j] < 2 && change[j] - t[i] < 2) { near++; break } }
           else if (c[i] != "200") http++
         }
         printf "{\"requests\":%d,\"httpErrors\":%d,\"noResponse\":%d,\"noResponseWithin2sOfAVersionChange\":%d,\"versionChanges\":%d}\n", n, http+0, none+0, near+0, k+0
       }' "$WORK/probe-$f.log" > "$WORK/probe-summary-$f.json"
  record probe "$(cat "$WORK/probe-summary-$f.json")"
}

FLAVORS=(native codedeploy); [[ "$ONLY" != both ]] && FLAVORS=("$ONLY")
for f in "${FLAVORS[@]}"; do ( run_flavor "$f" ) > "$WORK/log-$f.txt" 2>&1 & PIDS+=("$!"); JOBS_PIDS+=("$!"); done
for p in "${JOBS_PIDS[@]}"; do wait "$p" || true; done

# ------------------------------------------------------------------------------------------------------------------
# report
# ------------------------------------------------------------------------------------------------------------------
FAILED=0
pass() { printf '\033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
get() { jq -c --arg f "$1" --arg k "$2" 'select(.flavor==$f and .check==$k) | .data' "$WORK/result-$1.jsonl" 2>/dev/null | tail -1; }
for f in "${FLAVORS[@]}"; do
  echo "== $f"
  [[ -s "$WORK/result-$f.jsonl" ]] || { fail "$f: no results"; tail -5 "$WORK/log-$f.txt"; continue; }
  g="$(get "$f" good_release)"
  [[ "$(jq -r .result <<<"$g")" == SUCCEEDED && "$(jq -r .productionVersion <<<"$g")" == v2 ]] \
    && pass "$f good release: SUCCEEDED, production on v2; switch after $(jq .secondsToProductionSwitch <<<"$g") s, deployment ended after $(jq .secondsToDeploymentEnd <<<"$g") s" || fail "$f good release: $g"
  [[ "$(jq -r .testListenerShowedNewFirst <<<"$g")" == true ]] && pass "$f: the test listener answered v2 while production still answered v1" || fail "$f: the test listener window was not observed"
  h="$(get "$f" hook_fails)"
  [[ "$(jq -r .result <<<"$h")" == FAILED && "$(jq -r .productionVersion <<<"$h")" == v2 ]] \
    && pass "$f failing hook: rolled back after $(jq .secondsToGiveUp <<<"$h") s, production stayed on v2 ($(jq -r .detail <<<"$h"))" || fail "$f failing hook: $h"
  r="$(get "$f" rollback_in_bake)"
  [[ "$(jq .secondsFromRollbackToV2 <<<"$r")" -ge 0 && "$(jq -r .productionVersion <<<"$r")" == v2 ]] \
    && pass "$f rollback during the bake/wait: production served v4 after $(jq .secondsUntilProductionServedV4 <<<"$r") s and was back on v2 $(jq .secondsFromRollbackToV2 <<<"$r") s after the rollback" || fail "$f rollback in bake: $r"
  b="$(get "$f" broken_release)"
  [[ "$(jq -r .productionVersion <<<"$b")" == v2 ]] \
    && pass "$f broken release: production stayed on v2; the platform $([[ "$(jq -r .gaveUpByItself <<<"$b")" == true ]] && echo "gave up by itself after $(jq .secondsObserved <<<"$b") s" || echo "had not given up after $(jq .secondsObserved <<<"$b") s, so it was stopped")" || fail "$f broken release: $b"
  p="$(get "$f" probe)"
  [[ "$(jq .httpErrors <<<"$p")" == 0 && "$(jq .noResponseWithin2sOfAVersionChange <<<"$p")" == 0 ]] \
    && pass "$f: $(jq .requests <<<"$p") requests across $(jq .versionChanges <<<"$p") version changes: 0 HTTP errors, none of the $(jq .noResponse <<<"$p") no-response timeouts within 2 s of a change (they also occur in steady state)" \
    || fail "$f: the probe saw $(jq .httpErrors <<<"$p") HTTP errors and $(jq .noResponseWithin2sOfAVersionChange <<<"$p") no-response timeouts next to a version change in $(jq .requests <<<"$p") requests"
done
exit "$FAILED"
