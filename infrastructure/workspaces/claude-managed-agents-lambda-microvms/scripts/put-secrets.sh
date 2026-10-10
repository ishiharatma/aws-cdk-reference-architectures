#!/bin/bash
# Writes the two SecureString parameters the stack grants access to.
# CloudFormation cannot create SecureString parameters, so this runs once after the first deploy.
#
# Usage: ENV_KEY=<environment-key> SIGNING_SECRET=<whsec_...> ./scripts/put-secrets.sh <stack-name> [aws-cli-args...]
# Values come from environment variables so they stay out of the shell history and the process list.
set -euo pipefail

STACK_NAME="${1:?stack name is required}"
shift || true
: "${ENV_KEY:?ENV_KEY (self_hosted environment key) is required}"
: "${SIGNING_SECRET:?SIGNING_SECRET (webhook signing secret, whsec_...) is required}"

output() {
  aws cloudformation describe-stacks --stack-name "${STACK_NAME}" "$@" \
    --query "Stacks[0].Outputs[?OutputKey=='${OUTPUT_KEY}'].OutputValue" --output text
}
OUTPUT_KEY=EnvironmentKeyParamName; ENV_KEY_PARAM="$(output "$@")"
OUTPUT_KEY=SigningParamName;        SIGNING_PARAM="$(output "$@")"
OUTPUT_KEY=SecretsKeyAlias;         KEY_ALIAS="$(output "$@")"

echo "Writing ${ENV_KEY_PARAM} and ${SIGNING_PARAM} (KMS key: ${KEY_ALIAS})"
aws ssm put-parameter --type SecureString --overwrite --key-id "${KEY_ALIAS}" \
  --name "${ENV_KEY_PARAM}" --value "${ENV_KEY}" "$@" >/dev/null
aws ssm put-parameter --type SecureString --overwrite --key-id "${KEY_ALIAS}" \
  --name "${SIGNING_PARAM}" --value "${SIGNING_SECRET}" "$@" >/dev/null
echo "Done. Rotate later by running this script again with new values."
