#!/bin/bash
# Enable or disable a user without deleting the record.
# Usage: set-transfer-user-status.sh --user NAME (--enable | --disable) [--table NAME]
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

USER_NAME="" TABLE="" STATE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USER_NAME="${2:-}"; shift 2 ;;
    --enable) STATE=true; shift ;;
    --disable) STATE=false; shift ;;
    --table) TABLE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
require_tools; resolve_table
[[ -n "$USER_NAME" && -n "$STATE" ]] || die "--user and --enable/--disable are required"
validate_username "$USER_NAME"

aws dynamodb update-item --table-name "$TABLE" --key "$(ddb_key "$USER_NAME")" \
  --update-expression 'SET enabled = :e' --condition-expression 'attribute_exists(#u)' \
  --expression-attribute-names '{"#u":"user"}' \
  --expression-attribute-values "{\":e\":{\"BOOL\":$STATE}}" >/dev/null 2>/tmp/ddb-err.$$ || {
    if grep -q ConditionalCheckFailedException /tmp/ddb-err.$$; then rm -f /tmp/ddb-err.$$; die "user '$USER_NAME' not found"; fi
    cat /tmp/ddb-err.$$ >&2; rm -f /tmp/ddb-err.$$; exit 1; }
rm -f /tmp/ddb-err.$$
echo "User '$USER_NAME' enabled=$STATE"
