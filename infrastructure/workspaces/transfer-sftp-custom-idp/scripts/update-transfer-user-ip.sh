#!/bin/bash
# Replace the IP allow list of a user. Other attributes are not touched.
# Usage: update-transfer-user-ip.sh --user NAME --allowed-ip CIDR [--allowed-ip CIDR ...] [--table NAME]
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

USER_NAME="" TABLE="" CIDRS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USER_NAME="${2:-}"; shift 2 ;;
    --allowed-ip) CIDRS+=("${2:-}"); shift 2 ;;
    --table) TABLE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
require_tools; resolve_table
[[ -n "$USER_NAME" ]] || die "--user is required"
((${#CIDRS[@]} > 0)) || die "at least one --allowed-ip is required"
validate_username "$USER_NAME"
for c in "${CIDRS[@]}"; do validate_cidr "$c"; done

aws dynamodb update-item --table-name "$TABLE" --key "$(ddb_key "$USER_NAME")" \
  --update-expression 'SET ipv4_allow_list = :ips' --condition-expression 'attribute_exists(#u)' \
  --expression-attribute-names '{"#u":"user"}' \
  --expression-attribute-values "$(jq -nc --argjson ips "$(printf '%s\n' "${CIDRS[@]}" | jq -R . | jq -sc 'unique')" '{":ips":{SS:$ips}}')" \
  >/dev/null 2>/tmp/ddb-err.$$ || {
    if grep -q ConditionalCheckFailedException /tmp/ddb-err.$$; then rm -f /tmp/ddb-err.$$; die "user '$USER_NAME' not found"; fi
    cat /tmp/ddb-err.$$ >&2; rm -f /tmp/ddb-err.$$; exit 1; }
rm -f /tmp/ddb-err.$$
echo "Updated IP allow list of '$USER_NAME'."
print_user "$(get_user_item "$USER_NAME")"
