#!/usr/bin/env bash
# End-to-end check of the RAG pipeline: ingest the sample documents, then ask questions through the signed API.
# Usage: ./test-rag.sh --project <project> --env <env> [--region <region>] [--skip-ingest]
set -euo pipefail

PROJECT="" ENVIRONMENT="" REGION="${AWS_REGION:-ap-northeast-1}" INGEST=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --env) ENVIRONMENT="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --skip-ingest) INGEST=0; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$PROJECT" && -n "$ENVIRONMENT" ]] || { echo "Usage: $0 --project <project> --env <env> [--region <region>] [--skip-ingest]" >&2; exit 2; }
for cmd in aws curl jq; do command -v "$cmd" >/dev/null || { echo "$cmd is required" >&2; exit 1; }; done

export AWS_PROFILE="${AWS_PROFILE:-${PROJECT}-${ENVIRONMENT}}" AWS_DEFAULT_REGION="$REGION"
STACK="${PROJECT}-${ENVIRONMENT}-bedrock-kb-rag-s3-vectors"
DIR="$(cd "$(dirname "$0")" && pwd)"
FAILED=0
pass() { printf '\033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

API="$(out ApiUrl)"; API="${API%/}"; KB="$(out KnowledgeBaseId)"; DS="$(out DataSourceId)"; BUCKET="$(out DataBucketName)"
echo "api: $API  knowledge base: $KB"

# --- ingestion ------------------------------------------------------------------------------------------------------
if [[ "$INGEST" == 1 ]]; then
  aws s3 sync "$DIR/sample-docs" "s3://$BUCKET/" --delete --only-show-errors
  JOB="$(aws bedrock-agent start-ingestion-job --knowledge-base-id "$KB" --data-source-id "$DS" --query ingestionJob.ingestionJobId --output text)"
  for _ in $(seq 1 60); do
    STATUS="$(aws bedrock-agent get-ingestion-job --knowledge-base-id "$KB" --data-source-id "$DS" --ingestion-job-id "$JOB" --query ingestionJob.status --output text)"
    [[ "$STATUS" == "COMPLETE" || "$STATUS" == "FAILED" ]] && break; sleep 5
  done
  STATS="$(aws bedrock-agent get-ingestion-job --knowledge-base-id "$KB" --data-source-id "$DS" --ingestion-job-id "$JOB" --query ingestionJob.statistics --output json)"
  DOCS="$(ls "$DIR"/sample-docs/*.md | wc -l)"
  [[ "$STATUS" == "COMPLETE" && "$(jq .numberOfNewDocumentsIndexed <<<"$STATS")" -ge "$DOCS" || "$(jq '.numberOfModifiedDocumentsIndexed + .numberOfDocumentsScanned' <<<"$STATS")" -ge "$DOCS" && "$STATUS" == "COMPLETE" ]] \
    && pass "ingestion complete: $(jq -c '{scanned:.numberOfDocumentsScanned,indexed:.numberOfNewDocumentsIndexed,failed:.numberOfDocumentsFailed}' <<<"$STATS")" \
    || { fail "ingestion $STATUS: $STATS $(aws bedrock-agent get-ingestion-job --knowledge-base-id "$KB" --data-source-id "$DS" --ingestion-job-id "$JOB" --query 'ingestionJob.failureReasons' --output text)"; exit 1; }
fi

# --- signed requests ------------------------------------------------------------------------------------------------
eval "$(aws configure export-credentials --format env)"
call() { # $1 = path, $2 = JSON body -> prints "<status>\n<body>"
  curl -s -w '\n%{http_code}' -X POST "$API$1" -H 'content-type: application/json' -d "$2" \
    --aws-sigv4 "aws:amz:$REGION:execute-api" --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" -H "x-amz-security-token: $AWS_SESSION_TOKEN"
}
ask() { local r; r="$(call /ask "$1")"; ASK_CODE="${r##*$'\n'}"; ASK_BODY="${r%$'\n'*}"; }
search() { local r; r="$(call /search "$1")"; SEARCH_CODE="${r##*$'\n'}"; SEARCH_BODY="${r%$'\n'*}"; }

# --- 1. golden questions: the answer states the fact and cites the right document ---------------------------------------
check() { # question, regex the answer must match, document the citations must include
  ask "$(jq -nc --arg q "$1" '{question:$q}')"
  local answer; answer="$(jq -r .answer <<<"$ASK_BODY")"
  if [[ "$ASK_CODE" == 200 ]] && grep -Eqi "$2" <<<"$answer" && jq -e --arg d "$3" '[.citations[].source] | any(contains($d))' <<<"$ASK_BODY" >/dev/null; then
    pass "\"$1\" -> $(tr '\n' ' ' <<<"$answer" | cut -c1-90) [cites $3]"
  else fail "\"$1\" -> HTTP $ASK_CODE: $(tr '\n' ' ' <<<"$answer" | cut -c1-160) | sources: $(jq -c '[.citations[].source]' <<<"$ASK_BODY" 2>/dev/null)"; fi
}
check "When does the on-call rotation change?" "monday.*10[:.]?00|10[:.]?00.*monday" oncall-handbook
check "How many approvers does an expense above 50,000 JPY need?" "two|2" expense-policy
check "How long is evidence kept after a security incident?" "400" incident-response
check "How many days of paid leave do full-time employees get?" "20" leave-policy
check "What share of traffic does a canary release get and for how long?" "10.*(percent|%).*30|30.*10.*(percent|%)" deploy-policy
check "Who has to approve a refund of 100,000 JPY?" "team lead" refund-policy

# --- 2. a question the documents cannot answer is not answered from thin air -------------------------------------------------
ask '{"question":"What is the password of the office guest Wi-Fi?"}'
if [[ "$ASK_CODE" == 200 ]] && grep -Eqi "cannot|can't|unable|do not|don't|no information|not (find|contain|provide|mention|include|specif|available)" <<<"$(jq -r .answer <<<"$ASK_BODY")"; then
  pass "out-of-corpus question is declined: $(jq -r .answer <<<"$ASK_BODY" | tr '\n' ' ' | cut -c1-100)"
else fail "out-of-corpus question was answered: $(jq -r .answer <<<"$ASK_BODY" | cut -c1-160)"; fi

# --- 3. the metadata filter restricts retrieval to one department ----------------------------------------------------------
search '{"question":"Who has to approve a refund?","filter":"infrastructure","maxResults":4}'
if [[ "$SEARCH_CODE" == 200 ]] && jq -e '.results | length > 0 and all(.[]; .metadata.department == "infrastructure")' <<<"$SEARCH_BODY" >/dev/null; then
  pass "filter=infrastructure: only infrastructure chunks come back ($(jq '.results|length' <<<"$SEARCH_BODY") chunks, none from finance)"
else fail "filter did not restrict retrieval: $(jq -c '[.results[].source]' <<<"$SEARCH_BODY" 2>/dev/null)"; fi
ask '{"question":"Who has to approve a refund of 100,000 JPY?","filter":"infrastructure"}'
if [[ "$ASK_CODE" == 200 ]] && ! grep -qi "team lead" <<<"$(jq -r .answer <<<"$ASK_BODY")"; then pass "filter=infrastructure: the finance answer is not leaked"; else fail "filtered answer leaked the finance document"; fi

# --- 4. retrieval alone ranks the right document first, with scores -----------------------------------------------------------
search '{"question":"How long do we keep evidence after an incident?","maxResults":3}'
if [[ "$SEARCH_CODE" == 200 ]] && [[ "$(jq -r '.results[0].source' <<<"$SEARCH_BODY")" == *incident-response* ]] && jq -e '.results | all(.[]; .score != null)' <<<"$SEARCH_BODY" >/dev/null; then
  pass "/search: top chunk is incident-response.md (score $(jq '.results[0].score' <<<"$SEARCH_BODY"))"
else fail "/search ranked $(jq -c '[.results[] | {source,score}]' <<<"$SEARCH_BODY" 2>/dev/null)"; fi

# --- 5. a conversation keeps its context --------------------------------------------------------------------------------------
ask '{"question":"Who has to approve a refund of 100,000 JPY?"}'
SESSION="$(jq -r .sessionId <<<"$ASK_BODY")"
ask "$(jq -nc --arg s "$SESSION" '{question:"And what if it is 300,000 JPY?", sessionId:$s}')"
if [[ "$ASK_CODE" == 200 ]] && grep -Eqi "finance director" <<<"$(jq -r .answer <<<"$ASK_BODY")"; then pass "follow-up with the session id resolves 'it' to the refund: $(jq -r .answer <<<"$ASK_BODY" | tr '\n' ' ' | cut -c1-80)"
else fail "follow-up was not understood: $(jq -r .answer <<<"$ASK_BODY" | cut -c1-160)"; fi

# --- 6. the edges: bad input and no signature --------------------------------------------------------------------------------------
r="$(call /ask '{"question":""}')"; [[ "${r##*$'\n'}" == 400 ]] && pass "an empty question is rejected with 400" || fail "empty question -> ${r##*$'\n'}"
r="$(call /ask '{"question":"q","filter":"a\"b"}')"; [[ "${r##*$'\n'}" == 400 ]] && pass "a filter with a quote is rejected with 400" || fail "bad filter -> ${r##*$'\n'}"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/ask" -H 'content-type: application/json' -d '{"question":"q"}')"
[[ "$code" == 403 || "$code" == 401 ]] && pass "an unsigned request is refused ($code)" || fail "an unsigned request returned $code"

exit "$FAILED"
