#!/usr/bin/env bash
# Source this file to point the AWS CLI, SDKs, CDK CLI and repo test scripts at a running
# AWS Emulator (https://docs.aws.amazon.com/emulator/).
#
#   source scripts/aws-emulator/env.sh [PROJECT-ENV]   # e.g. emu-dev (default)
#
# The emulator writes a new set of keys on every start, so source this again after a restart.
# It also defines the profile PROJECT-ENV, because the repo's test scripts default to
# `--profile <project>-<env>`.

EMU_PORT="${EMU_PORT:-9297}"
EMU_PROFILE="${1:-emu-dev}"
EMU_DIR="$HOME/.aws/emulator/$EMU_PORT"
EMU_STATE_DIR="${EMU_STATE_DIR:-$HOME/.aws/emulator-env}"

if [ ! -f "$EMU_DIR/emulator_credentials" ]; then
  echo "AWS Emulator is not running on port $EMU_PORT ($EMU_DIR not found)" >&2
  return 1 2>/dev/null || exit 1
fi

mkdir -p "$EMU_STATE_DIR"
(
  umask 077
  { cat "$EMU_DIR/emulator_credentials"; echo; sed "s/^\[default\]/[$EMU_PROFILE]/" "$EMU_DIR/emulator_credentials"; } \
    > "$EMU_STATE_DIR/credentials"
  { cat "$EMU_DIR/config"; echo; sed "s/^\[default\]/[profile $EMU_PROFILE]/" "$EMU_DIR/config"; } \
    > "$EMU_STATE_DIR/config"
)

unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE
export AWS_ENDPOINT_URL="https://127.0.0.1:$EMU_PORT"
export AWS_SHARED_CREDENTIALS_FILE="$EMU_STATE_DIR/credentials"
export AWS_CONFIG_FILE="$EMU_STATE_DIR/config"
export AWS_CA_BUNDLE="$EMU_DIR/ca.pem"
export NODE_EXTRA_CA_CERTS="$EMU_DIR/ca.pem"
export AWS_EC2_METADATA_DISABLED=true
export AWS_DISABLE_HOST_PREFIX_INJECTION=true
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
export CDK_DEFAULT_ACCOUNT=000000000000
export CDK_DEFAULT_REGION=us-east-1
