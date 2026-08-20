#!/bin/bash
# filepath: check-public-safety.sh
#
# Pre-publish safety check for public-facing docs (README, per-architecture
# READMEs, docs/, pages/, and optionally dev.to drafts passed explicitly).
# Scans for secrets, PII, and local absolute paths before they get pushed to
# the public GitHub repo or a dev.to article.
#
#   ./scripts/check-public-safety.sh                # all git-tracked *.md files
#   ./scripts/check-public-safety.sh path/to/file.md # explicit files (e.g. a
#                                                     # dev.to draft outside this repo)
#
# Manual review does not scale as the diff grows, so this should be run
# before every publish. Exits 1 if anything is flagged.
#
# Environment-specific words (customer names, internal hosts, etc.) must not
# be hardcoded into this script — that would turn the script itself into a
# thing worth redacting. Put them in a gitignored file instead:
#
#   scripts/redaction-patterns.local.txt   one extended regex per line, # comments allowed
#
# See scripts/redaction-patterns.example.txt for the format.

set -euo pipefail
cd "$(dirname "$0")/.."

LOCAL_PATTERNS="scripts/redaction-patterns.local.txt"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
ylw() { printf '\033[33m%s\033[0m\n' "$*"; }

if [ "$#" -gt 0 ]; then
  FILES=("$@")
else
  # templates/ holds unfinished scaffolding (e.g. "Under construction" stubs)
  # copied into new architectures, not published content itself.
  mapfile -t FILES < <(git ls-files -- '*.md' | grep -v '^templates/')
fi

if [ "${#FILES[@]}" -eq 0 ]; then
  ylw "No target files found"
  exit 0
fi

fail_count=0

# $1=label, $2=extended regex, $3+=extra grep patterns to exclude from hits (optional)
scan() {
  local label="$1" pattern="$2"; shift 2
  local excludes=("$@")
  local hits
  hits=$(grep -nHE "$pattern" "${FILES[@]}" 2>/dev/null || true)
  local ex
  for ex in ${excludes[@]+"${excludes[@]}"}; do
    hits=$(printf '%s\n' "$hits" | grep -vE "$ex" || true)
  done
  hits=$(printf '%s\n' "$hits" | sed '/^$/d')
  if [ -n "$hits" ]; then
    red "NG  $label"
    printf '%s\n' "$hits" | sed 's/^/      /'
    fail_count=$((fail_count + 1))
  else
    grn "OK  $label"
  fi
}

echo "== Scanning: ${#FILES[@]} Markdown file(s) =="
echo

# ── 1. Credentials / keys ────────────────────────────────────
scan "Access keys / tokens" \
  'AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer [A-Za-z0-9._-]{20,}'

# ── 2. Email addresses (noreply / example.* are fine) ────────
scan "Real email addresses" \
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' \
  'users\.noreply\.github\.com' 'example\.(com|org|net)' 'noreply@anthropic\.com'

# ── 3. AWS account IDs ────────────────────────────────────────
# Exclude AWS's own placeholder account IDs used throughout their docs
# (123456789012, 111122223333, 999988887777, 222222222222, ...) and 12-digit
# runs that are actually part of a UUID (e.g. trailing segment of a v4 UUID).
scan "12-digit account IDs" '\b[0-9]{12}\b' \
  '\b(123456789012|111122223333|999988887777|222222222222|333333333333|444455556666|1{12})\b' \
  '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}'

# ── 4. Machine-local absolute paths ───────────────────────────
scan "Machine-local absolute paths" \
  '/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+|[A-Za-z]:\\+Users\\+[A-Za-z0-9._-]+'

# ── 5. Environment-specific patterns (if a local file exists) ─
if [ -f "$LOCAL_PATTERNS" ]; then
  pat=$(grep -vE '^\s*(#|$)' "$LOCAL_PATTERNS" | paste -sd '|' -)
  if [ -n "$pat" ]; then
    scan "Environment-specific patterns (${LOCAL_PATTERNS})" "$pat"
  fi
else
  ylw "--  Environment-specific patterns: skipped, ${LOCAL_PATTERNS} not found"
  echo "      Add internal hosts, customer names, etc. one regex per line to include them in the scan"
fi

# ── 6. Headings with no content before the next same/shallower heading ─
empty_heads=$(awk '
  FNR==1 { h=""; body=0; fence=0 }
  /^[[:space:]]*```/ { fence = !fence; next }
  fence { body = 1; next }
  match($0, /^#{1,6} /) {
    lvl = RLENGTH - 1
    if (h != "" && body == 0 && lvl <= hlvl) print FILENAME ":" hl ": " h
    h = $0; hl = FNR; hlvl = lvl; body = 0; next
  }
  /^[[:space:]]*$/ { next }
  { body = 1 }
' "${FILES[@]}" 2>/dev/null || true)
if [ -n "$empty_heads" ]; then
  red "NG  Empty headings"
  printf '%s\n' "$empty_heads" | sed 's/^/      /'
  fail_count=$((fail_count + 1))
else
  grn "OK  Empty headings"
fi

echo
if [ "$fail_count" -gt 0 ]; then
  red "=== $fail_count issue(s) found. Please fix before publishing ==="
  exit 1
fi
grn "=== All checks passed ==="
