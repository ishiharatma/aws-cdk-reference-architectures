#!/bin/bash
# Shared helpers for the SFTP user management scripts (run from AWS CloudShell).
# Requires: aws CLI v2, jq. ssh-keygen is used for key validation when available.

set -euo pipefail

IDENTITY_PROVIDER_KEY="${SFTP_IDENTITY_PROVIDER_KEY:-publickeys}"
CONFIG_FILE="${SFTP_ADMIN_CONFIG:-$HOME/.sftp-user-admin.conf}"

# Config file (optional) may define SFTP_USER_TABLE and SFTP_ACCESS_ROLE_ARN.
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "$*" >&2; }

require_tools() {
  command -v aws >/dev/null || die "aws CLI is required"
  command -v jq >/dev/null || die "jq is required"
}

resolve_table() {
  TABLE="${TABLE:-${SFTP_USER_TABLE:-}}"
  [[ -n "$TABLE" ]] || die "DynamoDB table name is required (--table, SFTP_USER_TABLE, or $CONFIG_FILE)"
}

# ---- validation -----------------------------------------------------------------------------

validate_username() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9_.-]{2,63}$ ]] \
    || die "invalid username '$1' (3-64 chars of lower-case a-z, 0-9, '_', '.', '-'; must start with a letter or digit)"
}

validate_role_arn() {
  [[ "$1" =~ ^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@/_-]+$ ]] || die "invalid IAM role ARN '$1'"
}

validate_home() {
  [[ "$1" =~ ^/[a-z0-9.-]{3,63}(/[^/[:space:]]+)*$ ]] \
    || die "invalid home directory '$1' (expected /<bucket>[/<prefix>])"
  [[ "$1" != *..* ]] || die "home directory must not contain '..'"
}

validate_cidr() {
  local cidr="$1" ip prefix o
  [[ "$cidr" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/([0-9]{1,2})$ ]] \
    || die "invalid IPv4 CIDR '$cidr' (example: 203.0.113.10/32)"
  for o in "${BASH_REMATCH[@]:1:4}"; do
    ((10#$o <= 255)) || die "invalid IPv4 CIDR '$cidr' (octet > 255)"
  done
  prefix="${BASH_REMATCH[5]}"
  ((10#$prefix <= 32)) || die "invalid IPv4 CIDR '$cidr' (prefix > 32)"
  ((10#$prefix >= 1)) || die "CIDR '$cidr' allows every address and is not accepted"
}

# Print a normalized key ("<type> <base64>", comment removed) or die.
normalize_public_key() {
  local file="$1" line
  [[ -f "$file" ]] || die "public key file not found: $file"
  line="$(grep -vE '^\s*(#|$)' "$file" | head -n1 | tr -d '\r')"
  [[ -n "$line" ]] || die "public key file is empty: $file"
  [[ "$line" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521)[[:space:]]+([A-Za-z0-9+/]+={0,3})([[:space:]].*)?$ ]] \
    || die "'$file' is not a supported OpenSSH public key (ssh-ed25519 / ssh-rsa / ecdsa-sha2-*). Never register a private key."
  local key="${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"
  if command -v ssh-keygen >/dev/null; then
    echo "$key" | ssh-keygen -l -f - >/dev/null 2>&1 || die "ssh-keygen rejected the public key in '$file'"
  fi
  echo "$key"
}

key_fingerprint() {
  if command -v ssh-keygen >/dev/null; then
    echo "$1" | ssh-keygen -l -f - 2>/dev/null | awk '{print $2}'
  else
    echo "(ssh-keygen unavailable)"
  fi
}

# ---- DynamoDB helpers -----------------------------------------------------------------------

ddb_key() { jq -nc --arg u "$1" --arg p "$IDENTITY_PROVIDER_KEY" '{user:{S:$u},identity_provider_key:{S:$p}}'; }

# Prints the item JSON, or nothing when it does not exist.
get_user_item() {
  aws dynamodb get-item --table-name "$TABLE" --key "$(ddb_key "$1")" --consistent-read \
    --query Item --output json | jq -c 'select(. != null)'
}

# Human readable summary. Public keys are shown as fingerprints only.
print_user() {
  local item="$1" key
  echo "user:           $(jq -r '.user.S' <<<"$item")"
  echo "enabled:        $(jq -r '.enabled.BOOL // "unset (treated as disabled)"' <<<"$item")"
  echo "role:           $(jq -r '.config.M.Role.S // "-"' <<<"$item")"
  echo "homeDirectory:  $(jq -r '.config.M.HomeDirectory.S // "-"' <<<"$item")"
  echo "allowedIps:     $(jq -r '(.ipv4_allow_list.SS // [.ipv4_allow_list.L[]?.S]) | join(", ")' <<<"$item")"
  echo "publicKeys:"
  while IFS= read -r key; do
    [[ -n "$key" ]] && echo "  - $(awk '{print $1}' <<<"$key") $(key_fingerprint "$key")"
  done < <(jq -r '.config.M.PublicKeys.SS // [] | .[]' <<<"$item")
}

# Parse "--table X" which every script shares; remaining args are returned via REST_ARGS.
