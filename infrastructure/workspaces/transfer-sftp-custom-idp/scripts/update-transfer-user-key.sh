#!/bin/bash
# Add or remove SSH public keys of a user (key rotation: add new -> switch client -> remove old).
# Usage: update-transfer-user-key.sh --user NAME --add-key FILE [--add-key FILE ...]
#        update-transfer-user-key.sh --user NAME --remove-fingerprint SHA256:xxxx [...]
#        (the last remaining key can not be removed; disable the user instead)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

USER_NAME="" TABLE=""
ADD_FILES=() REMOVE_FPS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USER_NAME="${2:-}"; shift 2 ;;
    --add-key) ADD_FILES+=("${2:-}"); shift 2 ;;
    --remove-fingerprint) REMOVE_FPS+=("${2:-}"); shift 2 ;;
    --table) TABLE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
require_tools; resolve_table
[[ -n "$USER_NAME" ]] || die "--user is required"
((${#ADD_FILES[@]} + ${#REMOVE_FPS[@]} > 0)) || die "specify --add-key and/or --remove-fingerprint"
validate_username "$USER_NAME"

ITEM="$(get_user_item "$USER_NAME")"
[[ -n "$ITEM" ]] || die "user '$USER_NAME' not found"

ADD_KEYS=()
for f in "${ADD_FILES[@]}"; do ADD_KEYS+=("$(normalize_public_key "$f")"); done

# Resolve fingerprints to the stored keys.
REMOVE_KEYS=()
for fp in "${REMOVE_FPS[@]}"; do
  match=""
  while IFS= read -r k; do
    [[ -n "$k" && "$(key_fingerprint "$k")" == "$fp" ]] && match="$k"
  done < <(jq -r '.config.M.PublicKeys.SS // [] | .[]' <<<"$ITEM")
  [[ -n "$match" ]] || die "no registered key with fingerprint '$fp'"
  REMOVE_KEYS+=("$match")
done

CURRENT="$(jq -c '.config.M.PublicKeys.SS // []' <<<"$ITEM")"
ADD_JSON="$(printf '%s\n' "${ADD_KEYS[@]:-}" | jq -R . | jq -sc 'map(select(. != ""))')"
REM_JSON="$(printf '%s\n' "${REMOVE_KEYS[@]:-}" | jq -R . | jq -sc 'map(select(. != ""))')"
RESULT_COUNT="$(jq -n --argjson c "$CURRENT" --argjson a "$ADD_JSON" --argjson r "$REM_JSON" '(($c + $a) - $r) | unique | length')"
((RESULT_COUNT >= 1)) || die "refusing to remove the last public key (disable the user instead)"

# ADD first, DELETE second: the user always keeps at least one valid key.
if [[ "$ADD_JSON" != "[]" ]]; then
  aws dynamodb update-item --table-name "$TABLE" --key "$(ddb_key "$USER_NAME")" \
    --update-expression 'ADD config.PublicKeys :k' --condition-expression 'attribute_exists(#u)' \
    --expression-attribute-names '{"#u":"user"}' \
    --expression-attribute-values "$(jq -nc --argjson k "$ADD_JSON" '{":k":{SS:$k}}')" >/dev/null
fi
if [[ "$REM_JSON" != "[]" ]]; then
  aws dynamodb update-item --table-name "$TABLE" --key "$(ddb_key "$USER_NAME")" \
    --update-expression 'DELETE config.PublicKeys :k' --condition-expression 'attribute_exists(#u)' \
    --expression-attribute-names '{"#u":"user"}' \
    --expression-attribute-values "$(jq -nc --argjson k "$REM_JSON" '{":k":{SS:$k}}')" >/dev/null
fi
echo "Updated keys of '$USER_NAME'."
print_user "$(get_user_item "$USER_NAME")"
