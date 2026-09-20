#!/usr/bin/env bash
# keycloak-setup.sh — Configure Keycloak after infrastructure deployment.
#
# This script:
#   1. Retrieves admin credentials from Secrets Manager
#   2. Creates the realm
#   3. Creates the OIDC client for ALB authentication
#   4. Stores the client secret in Secrets Manager
#
# All admin API calls go through an SSM port-forward session to the running
# Keycloak task (localhost from Keycloak's point of view) rather than the
# public Keycloak ALB DNS. Keycloak's master realm defaults to
# `sslRequired: EXTERNAL`, which rejects the admin password grant over plain
# HTTP for any client the ALB reports as a non-local address -- i.e. every
# request from outside the VPC, since this ALB has no HTTPS listener until
# Step 3 (custom domain) is done. Tunneling through SSM makes the request
# originate from inside the container itself, which Keycloak treats as local
# and exempts from the HTTPS requirement -- no security setting is weakened
# to make this work.
#
# Usage:
#   export PROJECT=myproject
#   export ENV=dev
#   export KC_URL=http://<keycloak-alb-dns>   # used for display / redirect URIs only
#   export REALM=myrealm
#   export APP_ALB_URL=https://<app-alb-dns>  # redirect URI
#   ./scripts/keycloak-setup.sh
#
# Requirements: aws CLI (with the Session Manager plugin installed), curl, jq

set -euo pipefail

: "${PROJECT:?Set PROJECT}"
: "${ENV:?Set ENV}"
: "${KC_URL:?Set KC_URL (Keycloak base URL, for display/redirect URIs)}"
: "${REALM:?Set REALM}"
: "${APP_ALB_URL:?Set APP_ALB_URL (App ALB URL for redirect)}"

CLIENT_ID="${CLIENT_ID:-alb-client}"
LOCAL_PORT="${LOCAL_PORT:-18080}"
CLUSTER="${PROJECT}-${ENV}-keycloak"
OIDC_SECRET_NAME="/${PROJECT}/${ENV}/keycloak/oidc-client"
ADMIN_SECRET_NAME="/${PROJECT}/${ENV}/keycloak/admin"
KC_LOCAL_URL="http://localhost:${LOCAL_PORT}"

echo "==> Locating the running Keycloak task in cluster '${CLUSTER}'..."
TASK_ARN=$(aws ecs list-tasks --cluster "${CLUSTER}" --desired-status RUNNING \
  --query 'taskArns[0]' --output text)
if [ -z "${TASK_ARN}" ] || [ "${TASK_ARN}" = "None" ]; then
  echo "ERROR: No running task found in cluster '${CLUSTER}'." >&2
  exit 1
fi
TASK_ID=$(basename "${TASK_ARN}")
RUNTIME_ID=$(aws ecs describe-tasks --cluster "${CLUSTER}" --tasks "${TASK_ID}" \
  --query 'tasks[0].containers[0].runtimeId' --output text)
SSM_TARGET="ecs:${CLUSTER}_${TASK_ID}_${RUNTIME_ID}"

echo "==> Opening an SSM port-forward session to the Keycloak task (localhost:${LOCAL_PORT})..."
aws ssm start-session --target "${SSM_TARGET}" \
  --document-name AWS-StartPortForwardingSession \
  --parameters "{\"portNumber\":[\"8080\"],\"localPortNumber\":[\"${LOCAL_PORT}\"]}" \
  > /tmp/keycloak-setup-ssm.log 2>&1 &
SSM_PID=$!
trap 'kill "${SSM_PID}" 2>/dev/null || true' EXIT

echo "==> Waiting for the tunnel to accept connections..."
for _ in $(seq 1 15); do
  if curl -s -o /dev/null "${KC_LOCAL_URL}/"; then
    break
  fi
  sleep 1
done
if ! curl -s -o /dev/null "${KC_LOCAL_URL}/"; then
  echo "ERROR: Could not reach Keycloak through the SSM tunnel. See /tmp/keycloak-setup-ssm.log" >&2
  exit 1
fi

echo "==> Fetching Keycloak admin credentials from Secrets Manager..."
ADMIN_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id "${ADMIN_SECRET_NAME}" \
  --query SecretString --output text)
KC_ADMIN=$(echo "${ADMIN_SECRET}" | jq -r '.username')
KC_ADMIN_PASS=$(echo "${ADMIN_SECRET}" | jq -r '.password')

echo "==> Obtaining admin access token..."
# --data-urlencode (not a raw -d string) because the generated admin password
# can contain characters that are special in application/x-www-form-urlencoded
# bodies (&, %, etc.) -- a literal '&' in the password truncates/corrupts the
# body and Keycloak returns a 500 "unknown_error" instead of a clean 401.
TOKEN=$(curl -s -X POST "${KC_LOCAL_URL}/realms/master/protocol/openid-connect/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "client_id=admin-cli" \
  --data-urlencode "username=${KC_ADMIN}" \
  --data-urlencode "password=${KC_ADMIN_PASS}" \
  --data-urlencode "grant_type=password" \
  | jq -r '.access_token')

if [ -z "${TOKEN}" ] || [ "${TOKEN}" = "null" ]; then
  echo "ERROR: Failed to obtain admin token via the SSM tunnel." >&2
  exit 1
fi

echo "==> Creating realm '${REALM}'..."
curl -s -o /dev/null -w "%{http_code}" -X POST "${KC_LOCAL_URL}/admin/realms" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "{
    \"realm\": \"${REALM}\",
    \"enabled\": true,
    \"displayName\": \"${REALM}\",
    \"ssoSessionMaxLifespan\": 28800,
    \"accessTokenLifespan\": 300
  }" || true
echo

echo "==> Creating OIDC client '${CLIENT_ID}'..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "${KC_LOCAL_URL}/admin/realms/${REALM}/clients" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "{
    \"clientId\": \"${CLIENT_ID}\",
    \"enabled\": true,
    \"protocol\": \"openid-connect\",
    \"publicClient\": false,
    \"standardFlowEnabled\": true,
    \"directAccessGrantsEnabled\": false,
    \"redirectUris\": [
      \"${APP_ALB_URL}/oauth2/idpresponse\"
    ],
    \"webOrigins\": [\"${APP_ALB_URL}\"],
    \"attributes\": {
      \"access.token.lifespan\": \"300\"
    }
  }")
echo "  HTTP ${HTTP_CODE}"

echo "==> Fetching client internal UUID..."
CLIENT_UUID=$(curl -s \
  "${KC_LOCAL_URL}/admin/realms/${REALM}/clients?clientId=${CLIENT_ID}" \
  -H "Authorization: Bearer ${TOKEN}" \
  | jq -r '.[0].id')

if [ -z "${CLIENT_UUID}" ] || [ "${CLIENT_UUID}" = "null" ]; then
  echo "ERROR: Could not find client '${CLIENT_ID}' in realm '${REALM}'." >&2
  exit 1
fi

echo "==> Retrieving client secret..."
CLIENT_SECRET=$(curl -s \
  "${KC_LOCAL_URL}/admin/realms/${REALM}/clients/${CLIENT_UUID}/client-secret" \
  -H "Authorization: Bearer ${TOKEN}" \
  | jq -r '.value')

if [ -z "${CLIENT_SECRET}" ] || [ "${CLIENT_SECRET}" = "null" ]; then
  echo "ERROR: Could not retrieve client secret." >&2
  exit 1
fi

echo "==> Updating OIDC client secret in Secrets Manager (${OIDC_SECRET_NAME})..."
aws secretsmanager update-secret \
  --secret-id "${OIDC_SECRET_NAME}" \
  --secret-string "{\"clientId\":\"${CLIENT_ID}\",\"clientSecret\":\"${CLIENT_SECRET}\"}"

echo
echo "==> Done! Summary:"
echo "  Keycloak URL : ${KC_URL}"
echo "  Realm        : ${REALM}"
echo "  Client ID    : ${CLIENT_ID}"
echo "  Secret stored: ${OIDC_SECRET_NAME}"
echo
echo "Next steps:"
echo "  1. Set oidcConfig.enabled=true and provide appDomainName in dev-params.ts"
echo "  2. Redeploy: npm run deploy:all"
echo "  3. (Optional) Run scripts/saml-setup.sh to configure SAML IdP"
