#!/usr/bin/env bash
# keycloak-setup.sh — Configure Keycloak after infrastructure deployment.
#
# This script:
#   1. Retrieves admin credentials from Secrets Manager
#   2. Creates the realm
#   3. Creates the OIDC client for ALB authentication
#   4. Stores the client secret in Secrets Manager
#
# Usage:
#   export PROJECT=myproject
#   export ENV=dev
#   export KC_URL=http://<keycloak-alb-dns>
#   export REALM=myrealm
#   export APP_ALB_URL=https://<app-alb-dns>  # redirect URI
#   ./scripts/keycloak-setup.sh
#
# Requirements: aws CLI, curl, jq

set -euo pipefail

: "${PROJECT:?Set PROJECT}"
: "${ENV:?Set ENV}"
: "${KC_URL:?Set KC_URL (Keycloak base URL)}"
: "${REALM:?Set REALM}"
: "${APP_ALB_URL:?Set APP_ALB_URL (App ALB URL for redirect)}"

CLIENT_ID="${CLIENT_ID:-alb-client}"
OIDC_SECRET_NAME="/${PROJECT}/${ENV}/keycloak/oidc-client"
ADMIN_SECRET_NAME="/${PROJECT}/${ENV}/keycloak/admin"

echo "==> Fetching Keycloak admin credentials from Secrets Manager..."
ADMIN_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id "${ADMIN_SECRET_NAME}" \
  --query SecretString --output text)
KC_ADMIN=$(echo "${ADMIN_SECRET}" | jq -r '.username')
KC_ADMIN_PASS=$(echo "${ADMIN_SECRET}" | jq -r '.password')

echo "==> Obtaining admin access token..."
TOKEN=$(curl -s -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "client_id=admin-cli&username=${KC_ADMIN}&password=${KC_ADMIN_PASS}&grant_type=password" \
  | jq -r '.access_token')

if [ -z "${TOKEN}" ] || [ "${TOKEN}" = "null" ]; then
  echo "ERROR: Failed to obtain admin token. Is Keycloak running at ${KC_URL}?" >&2
  exit 1
fi

echo "==> Creating realm '${REALM}'..."
curl -s -o /dev/null -w "%{http_code}" -X POST "${KC_URL}/admin/realms" \
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
  "${KC_URL}/admin/realms/${REALM}/clients" \
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
  "${KC_URL}/admin/realms/${REALM}/clients?clientId=${CLIENT_ID}" \
  -H "Authorization: Bearer ${TOKEN}" \
  | jq -r '.[0].id')

if [ -z "${CLIENT_UUID}" ] || [ "${CLIENT_UUID}" = "null" ]; then
  echo "ERROR: Could not find client '${CLIENT_ID}' in realm '${REALM}'." >&2
  exit 1
fi

echo "==> Retrieving client secret..."
CLIENT_SECRET=$(curl -s \
  "${KC_URL}/admin/realms/${REALM}/clients/${CLIENT_UUID}/client-secret" \
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
