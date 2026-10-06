#!/bin/bash
# Create a new SFTP user. Fails if the user already exists (conditional write).
# Usage: create-transfer-user.sh --user NAME --public-key FILE [--public-key FILE ...] \
#          --allowed-ip CIDR [--allowed-ip CIDR ...] --home /bucket/prefix [--role ARN] [--table NAME]
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

usage() { sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-1}"; }

USER_NAME="" HOME_DIR="" ROLE="${SFTP_ACCESS_ROLE_ARN:-}" TABLE=""
KEY_FILES=() CIDRS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USER_NAME="${2:-}"; shift 2 ;;
    --public-key) KEY_FILES+=("${2:-}"); shift 2 ;;
    --allowed-ip) CIDRS+=("${2:-}"); shift 2 ;;
    --home) HOME_DIR="${2:-}"; shift 2 ;;
    --role) ROLE="${2:-}"; shift 2 ;;
    --table) TABLE="${2:-}"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

require_tools; resolve_table
[[ -n "$USER_NAME" && -n "$HOME_DIR" && -n "$ROLE" ]] || usage
((${#KEY_FILES[@]} > 0)) || die "at least one --public-key is required"
((${#CIDRS[@]} > 0)) || die "at least one --allowed-ip is required (IP allow list is mandatory)"

validate_username "$USER_NAME"
validate_role_arn "$ROLE"
validate_home "$HOME_DIR"
for c in "${CIDRS[@]}"; do validate_cidr "$c"; done
KEYS=()
for f in "${KEY_FILES[@]}"; do KEYS+=("$(normalize_public_key "$f")"); done

ITEM="$(jq -nc \
  --arg u "$USER_NAME" --arg p "$IDENTITY_PROVIDER_KEY" --arg role "$ROLE" --arg home "$HOME_DIR" \
  --argjson keys "$(printf '%s\n' "${KEYS[@]}" | jq -R . | jq -sc 'unique')" \
  --argjson ips "$(printf '%s\n' "${CIDRS[@]}" | jq -R . | jq -sc 'unique')" \
  '{user:{S:$u}, identity_provider_key:{S:$p}, enabled:{BOOL:true},
    ipv4_allow_list:{SS:$ips},
    config:{M:{Role:{S:$role}, HomeDirectory:{S:$home}, PublicKeys:{SS:$keys}}}}')"

if aws dynamodb put-item --table-name "$TABLE" --item "$ITEM" \
     --condition-expression 'attribute_not_exists(#u)' --expression-attribute-names '{"#u":"user"}' 2>/tmp/ddb-err.$$; then
  echo "Created user '$USER_NAME'."
  print_user "$ITEM"
  rm -f /tmp/ddb-err.$$
else
  if grep -q ConditionalCheckFailedException /tmp/ddb-err.$$; then
    rm -f /tmp/ddb-err.$$; die "user '$USER_NAME' already exists (not overwritten). Use the update-* scripts."
  fi
  cat /tmp/ddb-err.$$ >&2; rm -f /tmp/ddb-err.$$; exit 1
fi
