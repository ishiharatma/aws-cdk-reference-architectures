#!/bin/bash

#######################################
# test-auth.sh
#
# End-to-end check of the deployed Cognito + API Gateway authorization. A clean `cdk deploy` does not
# prove that the *right* callers are let in and the wrong ones are kept out, so this signs real users
# in and calls the real API with the real token types:
#
#   authentication   no token / garbage token -> 401
#   token type       ID token on /me works; ACCESS token on /me and ID token on /notes are rejected (401)
#   scopes           custom scopes only exist in access tokens issued by an OAuth flow (authorization code +
#                    PKCE against the hosted UI, driven here with curl); a token from InitiateAuth carries
#                    none, so it is refused on /notes. A machine token (read only) cannot POST.
#   groups           /admin: member -> 403, admin -> 200
#   data isolation   a user only ever sees their own notes
#   refresh          a refresh token yields a working access token
#
# Creates three throw-away users (alice, bob: member; carol: admin) and deletes them on exit.
#
# Requires: aws CLI, curl, jq, openssl.
#
# Usage:
#   ./test-auth.sh --project PROJECT --env ENV [OPTIONS]
#######################################

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

PROJECT=""
ENVIRONMENT=""
PROFILE=""
REGION="ap-northeast-1"
STACK_NAME=""
DESTROY=false

API_URL=""
POOL_ID=""
WEB_CLIENT=""
MACHINE_CLIENT=""
TOKEN_ENDPOINT=""
PASSWORD=""
RUN_ID=""
USERS=()
PASS=0
FAIL=0

print_message() {
    echo -e "${1}${2}${NC}"
}

usage() {
    cat << EOF
Usage: $0 --project PROJECT --env ENV [OPTIONS]

Sign in test users and assert what the API lets each kind of token do.

OPTIONS:
    -p, --project PROJECT     Project name (required)
    -e, --env ENV             Environment name, e.g. dev/stg/prd (required)
    --profile PROFILE         AWS CLI profile (default: <project>-<env>)
    --region REGION           AWS region (default: ap-northeast-1)
    --stack-name NAME         CloudFormation stack (default: <project>-<env>-cognito-apigw-auth)
    --destroy                 Delete the stack afterwards
    -h, --help                Show this help message

Note: the web client needs the USER_PASSWORD_AUTH flow (EnvParams.enablePasswordAuthFlow, on in dev).
EOF
    exit 1
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -p|--project) PROJECT="$2"; shift 2 ;;
            -e|--env) ENVIRONMENT="$2"; shift 2 ;;
            --profile) PROFILE="$2"; shift 2 ;;
            --region) REGION="$2"; shift 2 ;;
            --stack-name) STACK_NAME="$2"; shift 2 ;;
            --destroy) DESTROY=true; shift ;;
            -h|--help) usage ;;
            *) print_message "$RED" "Unknown option: $1"; usage ;;
        esac
    done
}

validate_args() {
    if [[ -z "$PROJECT" || -z "$ENVIRONMENT" ]]; then
        print_message "$RED" "Error: --project and --env are required"
        usage
    fi
    PROFILE="${PROFILE:-${PROJECT}-${ENVIRONMENT}}"
    STACK_NAME="${STACK_NAME:-${PROJECT}-${ENVIRONMENT}-cognito-apigw-auth}"
}

check_requirements() {
    local missing=0
    for cmd in aws curl jq openssl; do
        if ! command -v "$cmd" > /dev/null 2>&1; then
            print_message "$RED" "Error: required command not found: $cmd"
            missing=1
        fi
    done
    [[ $missing -eq 0 ]] || exit 1
}

aws_cmd() {
    aws --profile "$PROFILE" --region "$REGION" "$@"
}

verify_credentials() {
    if ! aws_cmd sts get-caller-identity > /dev/null 2>&1; then
        print_message "$RED" "Error: cannot use AWS profile '$PROFILE'. Run: aws sso login --profile $PROFILE"
        exit 1
    fi
}

check() {
    local name="$1" ok="$2" detail="${3:-}"
    if [[ "$ok" == "true" ]]; then
        PASS=$((PASS + 1)); print_message "$GREEN" "  PASS  $name"
    else
        FAIL=$((FAIL + 1)); print_message "$RED" "  FAIL  $name ${detail:+($detail)}"
    fi
}

# Stack output keys are prefixed by the CDK Stage construct path, so match on the suffix.
stack_output() {
    aws_cmd cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?ends_with(OutputKey, '$1')].OutputValue | [0]" --output text
}

load_stack_info() {
    print_message "$BLUE" "==> Reading stack outputs from $STACK_NAME"
    API_URL="$(stack_output ApiUrl)"; API_URL="${API_URL%/}"
    POOL_ID="$(stack_output UserPoolId)"
    WEB_CLIENT="$(stack_output WebClientId)"
    MACHINE_CLIENT="$(stack_output MachineClientId)"
    TOKEN_ENDPOINT="$(stack_output TokenEndpoint)"
    if [[ -z "$API_URL" || "$API_URL" == "None" || -z "$POOL_ID" || "$POOL_ID" == "None" ]]; then
        print_message "$RED" "Error: stack outputs not found. Is $STACK_NAME deployed in $REGION?"
        exit 1
    fi
    echo "    API:  $API_URL"
    echo "    Pool: $POOL_ID"
}

create_user() {
    local name="$1" group="$2" email="${1}-${RUN_ID}@example.com"
    aws_cmd cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username "$email" --message-action SUPPRESS \
        --user-attributes "Name=email,Value=$email" "Name=email_verified,Value=true" > /dev/null
    aws_cmd cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" --username "$email" --password "$PASSWORD" --permanent
    aws_cmd cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" --username "$email" --group-name "$group"
    USERS+=("$email")
}

cleanup_users() {
    local u
    for u in "${USERS[@]:-}"; do
        [[ -n "$u" ]] && aws_cmd cognito-idp admin-delete-user --user-pool-id "$POOL_ID" --username "$u" > /dev/null 2>&1 || true
    done
}

# sign_in EMAIL -> JSON with IdToken / AccessToken / RefreshToken
sign_in() {
    aws_cmd cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH --client-id "$WEB_CLIENT" \
        --auth-parameters "USERNAME=$1,PASSWORD=$PASSWORD" --query AuthenticationResult --output json
}

# code_flow EMAIL -> JSON token response (id_token, access_token, refresh_token) from the hosted UI
# authorization-code + PKCE flow, scripted with curl (the login form is posted with its CSRF token).
code_flow() {
    local email="$1" redirect="http://localhost:3000/callback" verifier challenge jar page url csrf location code base q
    base="${TOKEN_ENDPOINT%/oauth2/token}"
    verifier="$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-64)"
    challenge="$(printf '%s' "$verifier" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
    q="client_id=$WEB_CLIENT&response_type=code&scope=openid+email+notes%2Fread+notes%2Fwrite&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback&code_challenge=$challenge&code_challenge_method=S256&state=test"
    jar="$(mktemp)"; page="$(mktemp)"
    url="$(curl -s -L -c "$jar" -b "$jar" -o "$page" -w '%{url_effective}' "$base/oauth2/authorize?$q")"
    csrf="$(grep -o 'name="_csrf" value="[^"]*"' "$page" | head -1 | sed 's/.*value="//;s/"//')"
    location="$(curl -s -c "$jar" -b "$jar" -D - -o /dev/null -X POST "$url" \
        --data-urlencode "_csrf=$csrf" --data-urlencode "username=$email" --data-urlencode "password=$PASSWORD" \
        | grep -i '^location:' | tr -d '\r')"
    rm -f "$jar" "$page"
    code="${location#*code=}"; code="${code%%&*}"
    curl -s -d grant_type=authorization_code -d "client_id=$WEB_CLIENT" -d "code=$code" -d "redirect_uri=$redirect" -d "code_verifier=$verifier" "$TOKEN_ENDPOINT"
}

# call METHOD PATH TOKEN [BODY] -> prints the HTTP status, then the body
call() {
    local method="$1" path="$2" token="$3" body="${4:-}" out
    local args=(-s -w '\n%{http_code}' -X "$method" "$API_URL$path")
    [[ -n "$token" ]] && args+=(-H "Authorization: $token")
    [[ -n "$body" ]] && args+=(-H 'Content-Type: application/json' -d "$body")
    out="$(curl "${args[@]}")"
    echo "${out##*$'\n'}"
    echo "${out%$'\n'*}"
}

status_of() { head -n1 <<< "$1"; }
body_of() { tail -n +2 <<< "$1"; }

expect_status() {
    local name="$1" expected="$2" result="$3" got
    got="$(status_of "$result")"
    check "$name -> $expected" "$([[ "$got" == "$expected" ]] && echo true || echo false)" "got $got: $(body_of "$result" | head -c 120)"
}

run_tests() {
    print_message "$BLUE" "==> Signing in users (hosted-UI authorization code + PKCE, and InitiateAuth for comparison)"
    local alice bob carol
    alice="$(code_flow "${USERS[0]}")"; bob="$(code_flow "${USERS[1]}")"; carol="$(code_flow "${USERS[2]}")"
    local alice_id alice_access alice_refresh bob_access carol_id
    alice_id="$(jq -r .id_token <<< "$alice")"; alice_access="$(jq -r .access_token <<< "$alice")"; alice_refresh="$(jq -r .refresh_token <<< "$alice")"
    bob_access="$(jq -r .access_token <<< "$bob")"
    carol_id="$(jq -r .id_token <<< "$carol")"
    check "users signed in through the hosted UI" "$([[ "$alice_id" != "null" && "$alice_access" != "null" && "$carol_id" != "null" ]] && echo true || echo false)" "$alice"
    local scopes
    scopes="$(cut -d. -f2 <<< "$alice_access" | tr '_-' '/+' | base64 -d 2>/dev/null | jq -r .scope || true)"
    check "the access token carries the custom scopes" "$([[ "$scopes" == *notes/read* && "$scopes" == *notes/write* ]] && echo true || echo false)" "scope: $scopes"

    print_message "$BLUE" "==> Authentication"
    expect_status "GET /me without a token" 401 "$(call GET /me "")"
    expect_status "GET /me with a garbage token" 401 "$(call GET /me "not.a.jwt")"

    print_message "$BLUE" "==> Token type: /me takes an ID token, /notes takes an access token"
    local me
    me="$(call GET /me "$alice_id")"
    expect_status "GET /me with alice's ID token" 200 "$me"
    check "the claims come from the verified token (email = alice)" "$([[ "$(body_of "$me" | jq -r .email)" == "${USERS[0]}" ]] && echo true || echo false)" "$(body_of "$me")"
    expect_status "GET /me with an ACCESS token" 401 "$(call GET /me "$alice_access")"
    expect_status "GET /notes with an ID token (scopes need an access token)" 401 "$(call GET /notes "$alice_id")"
    local direct
    direct="$(sign_in "${USERS[0]}" | jq -r .AccessToken)"
    expect_status "GET /notes with an access token from InitiateAuth (no custom scopes)" 401 "$(call GET /notes "$direct")"

    print_message "$BLUE" "==> Scopes and data isolation"
    local created
    created="$(call POST /notes "$alice_access" '{"text":"alice private note"}')"
    expect_status "alice POST /notes (scope notes/write)" 201 "$created"
    local alice_notes bob_notes
    alice_notes="$(call GET /notes "$alice_access")"
    expect_status "alice GET /notes (scope notes/read)" 200 "$alice_notes"
    check "alice sees her note" "$([[ "$(body_of "$alice_notes" | jq '[.notes[].text] | index("alice private note") != null')" == "true" ]] && echo true || echo false)" "$(body_of "$alice_notes")"
    bob_notes="$(call GET /notes "$bob_access")"
    expect_status "bob GET /notes" 200 "$bob_notes"
    check "bob does NOT see alice's note (partition = token subject)" "$([[ "$(body_of "$bob_notes" | jq '.notes | length')" == "0" ]] && echo true || echo false)" "$(body_of "$bob_notes")"
    expect_status "POST /notes with an invalid body is rejected by the request validator" 400 "$(call POST /notes "$alice_access" '{"nope":1}')"

    print_message "$BLUE" "==> Groups"
    expect_status "member GET /admin" 403 "$(call GET /admin "$alice_id")"
    expect_status "admin GET /admin" 200 "$(call GET /admin "$carol_id")"

    print_message "$BLUE" "==> Machine-to-machine (client_credentials, notes/read only)"
    local secret token
    secret="$(aws_cmd cognito-idp describe-user-pool-client --user-pool-id "$POOL_ID" --client-id "$MACHINE_CLIENT" --query UserPoolClient.ClientSecret --output text)"
    token="$(curl -s -u "$MACHINE_CLIENT:$secret" -d grant_type=client_credentials -d scope=notes/read "$TOKEN_ENDPOINT" | jq -r .access_token)"
    check "machine client obtained an access token" "$([[ -n "$token" && "$token" != "null" ]] && echo true || echo false)"
    expect_status "machine GET /notes (has notes/read)" 200 "$(call GET /notes "$token")"
    # An access token that lacks the method's scope is refused as 401 by the REST API Cognito authorizer (not 403).
    expect_status "machine POST /notes (lacks notes/write)" 401 "$(call POST /notes "$token" '{"text":"from a machine"}')"
    expect_status "machine GET /me (no user, no ID token)" 401 "$(call GET /me "$token")"

    print_message "$BLUE" "==> Refresh token"
    local refreshed
    refreshed="$(curl -s -d grant_type=refresh_token -d "client_id=$WEB_CLIENT" -d "refresh_token=$alice_refresh" "$TOKEN_ENDPOINT" | jq -r .access_token)"
    expect_status "GET /notes with an access token obtained from the refresh token" 200 "$(call GET /notes "$refreshed")"
}

main() {
    parse_args "$@"
    validate_args
    check_requirements
    verify_credentials
    load_stack_info

    RUN_ID="$(openssl rand -hex 3)"
    PASSWORD="Aa1!$(openssl rand -hex 8)zZ"
    trap cleanup_users EXIT
    print_message "$BLUE" "==> Creating test users (deleted on exit)"
    create_user alice member
    create_user bob member
    create_user carol admin

    run_tests

    if [[ "$DESTROY" == true ]]; then
        cleanup_users; USERS=()
        print_message "$BLUE" "==> Deleting stack $STACK_NAME"
        aws_cmd cloudformation delete-stack --stack-name "$STACK_NAME"
        aws_cmd cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
    fi

    echo
    if [[ $FAIL -eq 0 ]]; then
        print_message "$GREEN" "All checks passed ($PASS)"
    else
        print_message "$RED" "$FAIL check(s) failed, $PASS passed"
        exit 1
    fi
}

main "$@"
