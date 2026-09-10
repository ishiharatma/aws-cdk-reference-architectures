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
# Requirements: aws CLI, curl, jq

set -euo pipefail

: "${PROJECT:?Set PROJECT}"
: "${ENV:?Set ENV}"
: "${KC_URL:?Set KC_URL}"
: "${REALM:?Set REALM}"
: "${SAML_IDP_ALIAS:?Set SAML_IDP_ALIAS}"
: "${SAML_IDP_DISPLAY_NAME:?Set SAML_IDP_DISPLAY_NAME}"
: "${SAML_IDP_METADATA_URL:?Set SAML_IDP_METADATA_URL}"

ADMIN_SECRET_NAME="/${PROJECT}/${ENV}/keycloak/admin"

echo "==> Fetching Keycloak admin credentials..."
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
  echo "ERROR: Failed to obtain admin token." >&2
  exit 1
fi

echo "==> Fetching SAML IdP metadata from ${SAML_IDP_METADATA_URL}..."
# Import the SAML IdP metadata URL directly into Keycloak
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "${KC_URL}/admin/realms/${REALM}/identity-provider/instances" \
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
