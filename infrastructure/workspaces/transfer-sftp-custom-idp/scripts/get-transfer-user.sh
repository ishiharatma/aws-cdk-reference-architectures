#!/bin/bash
# Show one SFTP user (public keys are shown as fingerprints only).
# Usage: get-transfer-user.sh --user NAME [--table NAME]
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

USER_NAME="" TABLE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USER_NAME="${2:-}"; shift 2 ;;
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
print_user "$ITEM"
