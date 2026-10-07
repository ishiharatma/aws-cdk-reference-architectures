#!/bin/bash
# List all SFTP users.
# Usage: list-transfer-users.sh [--table NAME]
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

TABLE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --table) TABLE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
require_tools; resolve_table
aws dynamodb scan --table-name "$TABLE" --consistent-read --output json \
  | jq -r '["USER","ENABLED","KEYS","ALLOWED_IPS","HOME"],
      (.Items | sort_by(.user.S)[] |
       [.user.S, (.enabled.BOOL // false | tostring), ((.config.M.PublicKeys.SS // []) | length | tostring),
        ((.ipv4_allow_list.SS // []) | join(",")), (.config.M.HomeDirectory.S // "-")]) | @tsv' \
  | column -t -s $'\t'
