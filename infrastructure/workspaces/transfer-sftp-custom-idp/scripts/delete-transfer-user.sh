#!/bin/bash
# Delete a user after showing it and asking for confirmation (type the user name).
# Usage: delete-transfer-user.sh --user NAME [--force] [--table NAME]
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

USER_NAME="" TABLE="" FORCE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USER_NAME="${2:-}"; shift 2 ;;
    --force) FORCE=true; shift ;;
    --table) TABLE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
require_tools; resolve_table
[[ -n "$USER_NAME" ]] || die "--user is required"
validate_username "$USER_NAME"

ITEM="$(get_user_item "$USER_NAME")"
[[ -n "$ITEM" ]] || die "user '$USER_NAME' not found"
echo "The following user will be deleted:"
print_user "$ITEM"

if [[ "$FORCE" != true ]]; then
  read -r -p "Type the user name '$USER_NAME' to confirm deletion: " answer
  [[ "$answer" == "$USER_NAME" ]] || die "confirmation did not match; nothing deleted"
fi

aws dynamodb delete-item --table-name "$TABLE" --key "$(ddb_key "$USER_NAME")" \
  --condition-expression 'attribute_exists(#u)' --expression-attribute-names '{"#u":"user"}' >/dev/null
echo "Deleted user '$USER_NAME'. S3 objects under the home directory are not deleted."
