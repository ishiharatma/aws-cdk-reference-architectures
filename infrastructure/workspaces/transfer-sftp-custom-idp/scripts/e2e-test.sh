#!/bin/bash
# End-to-end check against a deployed stack (test plan cases 1-11). Creates and deletes temporary
# users (e2e-*), so run it only against a verification environment.
# Works for all run modes: with a controller function (manual / scheduled) the server is started first.
# Usage: e2e-test.sh --stack STACK_NAME [--profile PROFILE] [--region REGION] [--my-ip IPV4] [--recycle]
#   --recycle  (manual / scheduled) also stop and start the server again and check users, data and host key
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

STACK="" PROFILE_ARGS=() MY_IP="" RECYCLE=false REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-1}}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack) STACK="$2"; shift 2 ;;
    --profile) PROFILE_ARGS=(--profile "$2"); export AWS_PROFILE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --my-ip) MY_IP="$2"; shift 2 ;;
    --recycle) RECYCLE=true; shift ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
done
[[ -n "$STACK" ]] || { echo "--stack is required"; exit 1; }
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
[[ -n "$MY_IP" ]] || MY_IP="$(curl -s https://checkip.amazonaws.com | tr -d '\n')"

controller_status() {
  local f; f="$(mktemp)"
  aws lambda invoke --function-name "$CONTROLLER" --cli-binary-format raw-in-base64-out --payload '{"action":"status"}' "$f" >/dev/null
  cat "$f"; rm -f "$f"
}

out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
export SFTP_USER_TABLE="$(out UserTableName)"
BUCKET="$(out BucketName)"; ROLE="$(out TransferAccessRoleArn)"; FN="$(out IdpFunctionName)"
CONTROLLER="$(out ControllerFunctionName)"
if [[ -n "$CONTROLLER" && "$CONTROLLER" != None ]]; then
  export SFTP_CONTROLLER_FUNCTION="$CONTROLLER"
  echo "== on-demand server: starting"
  "$SCRIPT_DIR/control-transfer-server.sh" start --wait >/dev/null || { echo "could not start the server"; exit 1; }
  SERVER_ID="$(controller_status | jq -r .serverId)"
else
  SERVER_ID="$(out ServerId)"
fi
HOST="$SERVER_ID.server.transfer.$REGION.amazonaws.com"
WORK="$(mktemp -d)"; trap 'cleanup' EXIT
PASS=0 FAIL=0

cleanup() {
  for u in e2e-user01 e2e-user02 e2e-user03 e2e-user04; do
    "$SCRIPT_DIR/delete-transfer-user.sh" --user "$u" --force >/dev/null 2>&1 || true
  done
  aws s3 rm "s3://$BUCKET/e2e-" --recursive --exclude "*" --include "e2e-*" >/dev/null 2>&1 || true
  if aws iam get-role --role-name e2e-session-policy-test >/dev/null 2>&1; then
    for pn in $(aws iam list-role-policies --role-name e2e-session-policy-test --query PolicyNames --output text); do
      aws iam delete-role-policy --role-name e2e-session-policy-test --policy-name "$pn" >/dev/null 2>&1
    done
    aws iam delete-role --role-name e2e-session-policy-test >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}

check() { # check "name" expected(0=success,1=failure) actual_rc
  local ok=false
  if [[ "$2" == 0 && "$3" == 0 ]] || [[ "$2" == 1 && "$3" != 0 ]]; then ok=true; fi
  if $ok; then PASS=$((PASS+1)); echo "PASS  $1"; else FAIL=$((FAIL+1)); echo "FAIL  $1 (rc=$3)"; fi
}

# A new server host name needs a short time before it resolves and accepts connections.
wait_ssh_ready() {
  for _ in $(seq 1 60); do
    [[ -n "$(ssh-keyscan -T 5 -t ed25519,rsa "$HOST" 2>/dev/null)" ]] && return 0
    sleep 10
  done
  return 1
}

sftp_run() { # sftp_run user key batch-file
  sftp -i "$2" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
       -o ConnectTimeout=15 -b "$3" "$1@$HOST" >"$WORK/sftp.out" 2>&1
}

for n in a b c; do ssh-keygen -q -t ed25519 -N '' -f "$WORK/key-$n" -C "e2e-$n"; done
echo "hello" > "$WORK/hello.txt"
printf 'put %s hello.txt\nls\n' "$WORK/hello.txt" > "$WORK/put.batch"
printf 'ls\n' > "$WORK/ls.batch"
printf 'ls /e2e-user02\n' > "$WORK/cross.batch"

wait_ssh_ready || { echo "server did not accept connections in time"; exit 1; }
echo "== setup (server $SERVER_ID, my ip $MY_IP)"
PREFIX24="$(echo "$MY_IP" | awk -F. '{print $1"."$2"."$3".0/24"}')"
"$SCRIPT_DIR/create-transfer-user.sh" --user e2e-user01 --public-key "$WORK/key-a.pub" --allowed-ip "$MY_IP/32" --home "/$BUCKET/e2e-user01" --role "$ROLE" >/dev/null
"$SCRIPT_DIR/create-transfer-user.sh" --user e2e-user02 --public-key "$WORK/key-a.pub" --allowed-ip "$PREFIX24" --home "/$BUCKET/e2e-user02" --role "$ROLE" >/dev/null
"$SCRIPT_DIR/create-transfer-user.sh" --user e2e-user03 --public-key "$WORK/key-a.pub" --allowed-ip 192.0.2.1/32 --home "/$BUCKET/e2e-user03" --role "$ROLE" >/dev/null
"$SCRIPT_DIR/create-transfer-user.sh" --user e2e-user04 --public-key "$WORK/key-a.pub" --allowed-ip "$MY_IP/32" --home "/$BUCKET/e2e-user04" --role "$ROLE" >/dev/null
# duplicate create must not overwrite
"$SCRIPT_DIR/create-transfer-user.sh" --user e2e-user01 --public-key "$WORK/key-b.pub" --allowed-ip "$MY_IP/32" --home "/$BUCKET/e2e-user01" --role "$ROLE" >/dev/null 2>&1
check "create refuses to overwrite an existing user" 1 $?

echo "== normal cases"
sftp_run e2e-user01 "$WORK/key-a" "$WORK/put.batch"; check "1. registered user + correct key + allowed IP" 0 $?
"$SCRIPT_DIR/update-transfer-user-key.sh" --user e2e-user01 --add-key "$WORK/key-b.pub" >/dev/null
sftp_run e2e-user01 "$WORK/key-b" "$WORK/ls.batch"; check "2. one of multiple registered keys (new key)" 0 $?
sftp_run e2e-user01 "$WORK/key-a" "$WORK/ls.batch"; check "2. one of multiple registered keys (old key)" 0 $?
FPA="$(ssh-keygen -l -f "$WORK/key-a.pub" | awk '{print $2}')"
"$SCRIPT_DIR/update-transfer-user-key.sh" --user e2e-user01 --remove-fingerprint "$FPA" >/dev/null
sftp_run e2e-user01 "$WORK/key-a" "$WORK/ls.batch"; check "2. removed old key is rejected" 1 $?
sftp_run e2e-user01 "$WORK/key-b" "$WORK/ls.batch"; check "2. remaining key still works" 0 $?
sftp_run e2e-user02 "$WORK/key-a" "$WORK/put.batch"; check "3. IP inside allowed CIDR" 0 $?

echo "== failure cases"
sftp_run e2e-user03 "$WORK/key-a" "$WORK/ls.batch"; check "4. correct key + IP not allowed" 1 $?
sftp_run e2e-user01 "$WORK/key-c" "$WORK/ls.batch"; check "5. unregistered private key" 1 $?
sftp_run e2e-nouser "$WORK/key-a" "$WORK/ls.batch"; check "6. unknown user" 1 $?
"$SCRIPT_DIR/set-transfer-user-status.sh" --user e2e-user04 --disable >/dev/null
sftp_run e2e-user04 "$WORK/key-a" "$WORK/ls.batch"; check "7. disabled user" 1 $?
"$SCRIPT_DIR/set-transfer-user-status.sh" --user e2e-user04 --enable >/dev/null
sftp_run e2e-user04 "$WORK/key-a" "$WORK/ls.batch"; check "7. re-enabled user" 0 $?

OLD_ENV="$(aws lambda get-function-configuration --function-name "$FN" --query Environment --output json)"
aws lambda update-function-configuration --function-name "$FN" \
  --environment "$(jq -c '.Variables.USER_TABLE_NAME="does-not-exist" | {Variables:.Variables}' <<<"$OLD_ENV")" >/dev/null
aws lambda wait function-updated --function-name "$FN"
sftp_run e2e-user01 "$WORK/key-b" "$WORK/ls.batch"; check "8. DynamoDB error (fail closed)" 1 $?
aws lambda update-function-configuration --function-name "$FN" --environment "$(jq -c '{Variables:.Variables}' <<<"$OLD_ENV")" >/dev/null
aws lambda wait function-updated --function-name "$FN"

aws transfer test-identity-provider --server-id "$SERVER_ID" --user-name e2e-user01 --server-protocol FTP --source-ip "$MY_IP" \
  --query Response --output text 2>&1 | grep -q 'Role' ; check "9. invalid protocol (FTP) via test-identity-provider" 1 $?
aws transfer test-identity-provider --server-id "$SERVER_ID" --user-name e2e-user01 --server-protocol SFTP --source-ip 192.0.2.99 \
  --query Response --output text 2>&1 | grep -q 'Role' ; check "4b. test-identity-provider with a foreign source IP" 1 $?
aws transfer test-identity-provider --server-id "$SERVER_ID" --user-name e2e-user01 --server-protocol SFTP --source-ip "$MY_IP" \
  --query Response --output text 2>&1 | grep -q 'Role' ; check "1b. test-identity-provider with the allowed IP" 0 $?

echo "== authorization"
sftp_run e2e-user01 "$WORK/key-b" "$WORK/cross.batch"; check "11. e2e-user01 cannot reach e2e-user02 area" 1 $?
aws s3 ls "s3://$BUCKET/e2e-user01/hello.txt" >/dev/null; check "10. e2e-user01 upload landed in its own prefix" 0 $?
aws s3 ls "s3://$BUCKET/e2e-user02/hello.txt" >/dev/null; check "10. e2e-user02 upload landed in its own prefix" 0 $?
aws s3 ls "s3://$BUCKET/e2e-user01/e2e-user02" >/dev/null 2>&1; check "11. nothing of user02 under user01 prefix" 1 $?

echo "== session policy alone (the role is broad, only the Lambda session policy narrows it)"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
aws iam create-role --role-name e2e-session-policy-test --assume-role-policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"AWS\":\"arn:aws:iam::$ACCOUNT:root\"},\"Action\":\"sts:AssumeRole\"}]}" >/dev/null
SRC_ROLE_NAME="${ROLE##*/}"
for pn in $(aws iam list-role-policies --role-name "$SRC_ROLE_NAME" --query PolicyNames --output text); do
  aws iam put-role-policy --role-name e2e-session-policy-test --policy-name "$pn" \
    --policy-document "$(aws iam get-role-policy --role-name "$SRC_ROLE_NAME" --policy-name "$pn" --query PolicyDocument --output json)"
done
SESSION_POLICY="$(aws transfer test-identity-provider --server-id "$SERVER_ID" --user-name e2e-user01 --server-protocol SFTP --source-ip "$MY_IP" --query Response --output text | jq -r '.Policy')"
sleep 15
for attempt in 1 2 3 4 5 6; do
  CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::$ACCOUNT:role/e2e-session-policy-test" --role-session-name e2e --policy "$SESSION_POLICY" --output json 2>/dev/null)" && break
  sleep 10
done
CREDS_BROAD="$(aws sts assume-role --role-arn "arn:aws:iam::$ACCOUNT:role/e2e-session-policy-test" --role-session-name e2e-broad --output json)"
with_creds() { # with_creds "<creds json>" cmd...
  local c="$1"; shift
  env -u AWS_PROFILE AWS_ACCESS_KEY_ID="$(jq -r .Credentials.AccessKeyId <<<"$c")" \
    AWS_SECRET_ACCESS_KEY="$(jq -r .Credentials.SecretAccessKey <<<"$c")" \
    AWS_SESSION_TOKEN="$(jq -r .Credentials.SessionToken <<<"$c")" "$@"
}
echo sp > "$WORK/sp.txt"
with_creds "$CREDS" aws s3 cp "$WORK/sp.txt" "s3://$BUCKET/e2e-user01/sp.txt" >/dev/null 2>&1; check "12. session policy allows write in own prefix" 0 $?
with_creds "$CREDS" aws s3 cp "$WORK/sp.txt" "s3://$BUCKET/e2e-user02/sp.txt" >/dev/null 2>&1; check "12. session policy denies write in another prefix" 1 $?
with_creds "$CREDS" aws s3 cp "s3://$BUCKET/e2e-user02/hello.txt" - >/dev/null 2>&1; check "12. session policy denies read in another prefix" 1 $?
with_creds "$CREDS" aws s3 ls "s3://$BUCKET/e2e-user02/" >/dev/null 2>&1; check "12. session policy denies listing another prefix" 1 $?
with_creds "$CREDS" aws s3 ls "s3://$BUCKET/" >/dev/null 2>&1; check "12. session policy denies listing the bucket root" 1 $?
with_creds "$CREDS" aws s3 ls "s3://$BUCKET/e2e-user01/" >/dev/null 2>&1; check "12. session policy allows listing own prefix" 0 $?
with_creds "$CREDS_BROAD" aws s3 ls "s3://$BUCKET/e2e-user02/" >/dev/null 2>&1; check "12. control: the role alone can list another prefix" 0 $?

if [[ "$RECYCLE" == true && -n "$CONTROLLER" && "$CONTROLLER" != None ]]; then
  echo "== recycle: stop, start, check persistence"
  FP_BEFORE="$(ssh-keyscan -t ed25519,rsa -p 22 "$HOST" 2>/dev/null | ssh-keygen -lf /dev/stdin | sort | awk '{print $2,$4}' | tr '\n' ' ')"
  "$SCRIPT_DIR/control-transfer-server.sh" stop >/dev/null
  for _ in $(seq 1 30); do
    [[ "$(controller_status | jq -r .state)" == ABSENT ]] && break
    sleep 5
  done
  [[ "$(controller_status | jq -r .state)" == ABSENT ]]; check "13. server is deleted after stop" 0 $?
  OLD_SERVER_ID="$SERVER_ID"
  "$SCRIPT_DIR/control-transfer-server.sh" start --wait >/dev/null
  SERVER_ID="$(controller_status | jq -r .serverId)"
  HOST="$SERVER_ID.server.transfer.$REGION.amazonaws.com"
  wait_ssh_ready
  [[ "$SERVER_ID" != "$OLD_SERVER_ID" ]]; check "13. new server ID after re-creation ($OLD_SERVER_ID -> $SERVER_ID)" 0 $?
  sftp_run e2e-user01 "$WORK/key-b" "$WORK/ls.batch"; check "13. existing user can log in after re-creation (no re-registration)" 0 $?
  grep -q hello.txt "$WORK/sftp.out"; check "13. uploaded file is still there after re-creation" 0 $?
  FP_AFTER="$(ssh-keyscan -t ed25519,rsa -p 22 "$HOST" 2>/dev/null | ssh-keygen -lf /dev/stdin | sort | awk '{print $2,$4}' | tr '\n' ' ')"
  echo "host key fingerprints before: $FP_BEFORE"; echo "host key fingerprints after:  $FP_AFTER"
  echo "INFO  host key is $([[ "$FP_BEFORE" == "$FP_AFTER" ]] && echo unchanged || echo changed) after re-creation"
fi

echo
echo "RESULT: $PASS passed, $FAIL failed"
aws s3 rm "s3://$BUCKET/" --recursive --exclude "*" --include "e2e-user*" >/dev/null 2>&1 || true
[[ $FAIL -eq 0 ]]
