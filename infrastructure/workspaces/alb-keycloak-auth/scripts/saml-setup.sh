#!/usr/bin/env bash
# saml-setup.sh — Configure SAML identity provider federation in Keycloak.
#
# This implements Pattern B: Keycloak acts as an OIDC provider to ALB
# while brokering authentication to an external SAML IdP.
#
# Flow:
#   User → App ALB (OIDC) → Keycloak → SAML IdP → Keycloak → App ALB → Backend
#
# Usage:
#   export PROJECT=myproject
#   export ENV=dev
#   export KC_URL=http://<keycloak-alb-dns>
#   export REALM=myrealm
#   export SAML_IDP_ALIAS=corp-saml
#   export SAML_IDP_DISPLAY_NAME='Corporate SSO'
#   export SAML_IDP_METADATA_URL=https://your-idp.example.com/saml/metadata
#   ./scripts/saml-setup.sh
#
# Note: Run keycloak-setup.sh first to create the realm.
# Requirements: aws CLI (with the Session Manager plugin installed), curl, jq
#
# Like keycloak-setup.sh, all admin API calls go through an SSM port-forward
# to the running Keycloak task rather than the public ALB DNS -- Keycloak's
# `sslRequired: external` realm policy rejects the admin password grant (and
# every other realm-scoped endpoint) over plain HTTP from outside the VPC.
# See keycloak-setup.sh's header comment for the full explanation.

set -euo pipefail

: "${PROJECT:?Set PROJECT}"
: "${ENV:?Set ENV}"
: "${KC_URL:?Set KC_URL (Keycloak base URL, for display only)}"
: "${REALM:?Set REALM}"
: "${SAML_IDP_ALIAS:?Set SAML_IDP_ALIAS}"
: "${SAML_IDP_DISPLAY_NAME:?Set SAML_IDP_DISPLAY_NAME}"
: "${SAML_IDP_METADATA_URL:?Set SAML_IDP_METADATA_URL}"

LOCAL_PORT="${LOCAL_PORT:-18080}"
CLUSTER="${PROJECT}-${ENV}-keycloak"
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
  > /tmp/saml-setup-ssm.log 2>&1 &
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
  echo "ERROR: Could not reach Keycloak through the SSM tunnel. See /tmp/saml-setup-ssm.log" >&2
  exit 1
fi

echo "==> Fetching Keycloak admin credentials..."
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

echo "==> Fetching SAML IdP metadata from ${SAML_IDP_METADATA_URL}..."
# Import the SAML IdP metadata URL directly into Keycloak
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "${KC_LOCAL_URL}/admin/realms/${REALM}/identity-provider/instances" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "{
    \"alias\": \"${SAML_IDP_ALIAS}\",
    \"displayName\": \"${SAML_IDP_DISPLAY_NAME}\",
    \"providerId\": \"saml\",
    \"enabled\": true,
    \"trustEmail\": true,
    \"storeToken\": false,
    \"addReadTokenRoleOnCreate\": false,
    \"firstBrokerLoginFlowAlias\": \"first broker login\",
    \"config\": {
      \"metadataDescriptorUrl\": \"${SAML_IDP_METADATA_URL}\",
      \"useJwksUrl\": \"false\",
      \"syncMode\": \"IMPORT\",
      \"nameIDPolicyFormat\": \"urn:oasis:names:tc:SAML:2.0:nameid-format:persistent\",
      \"principalType\": \"SUBJECT\",
      \"signatureAlgorithm\": \"RSA_SHA256\",
      \"xmlSigKeyInfoKeyNameTransformer\": \"KEY_ID\",
      \"allowCreate\": \"true\",
      \"postBindingResponse\": \"true\",
      \"postBindingAuthnRequest\": \"true\",
      \"postBindingLogout\": \"true\",
      \"wantAssertionsSigned\": \"true\",
      \"wantAssertionsEncrypted\": \"false\",
      \"forceAuthn\": \"false\",
      \"backchannelSupported\": \"false\"
    }
  }")
echo "  HTTP ${HTTP_CODE}"

echo
echo "==> Keycloak SAML SP metadata (share this with your IdP admin):"
echo "  ${KC_URL}/realms/${REALM}/protocol/saml/descriptor"
echo

echo "==> Done! SAML IdP '${SAML_IDP_ALIAS}' configured in realm '${REALM}'."
echo
echo "Next steps for your SAML IdP admin:"
echo "  1. Register Keycloak as a Service Provider using the metadata above"
echo "  2. Configure attribute mappings (e.g. email → email, name → given_name)"
echo "  3. Test by accessing the App ALB URL — you should be redirected to the SAML IdP"
