#!/bin/bash
# PreToolUse hook: detect outbound write commands via the gh CLI.
#
# This is a guardrail against typical gh CLI mistakes, not a security
# boundary. It cannot fully account for variable expansion, aliases, other
# CLIs, or direct API clients, so it should be combined with least-privilege
# permissions and manual review.
#
# Detects gh CLI write operations and extracts the target repository owner:
# - operations against this project's own repo (OWN_OWNERS below) pass through
# - operations against any other owner, or where the target can't be
#   determined, are switched to permissionDecision=ask (which overrides a
#   blanket Bash(*) allow in settings.json)
#
# The target owner is not inferred from "does the command string contain the
# owner name" — it is extracted strictly from -R/--repo flags, GitHub URLs,
# or API paths (repos/<owner>/...) and compared exactly.

input=$(cat)

tool_name=$(echo "$input" | jq -r '.tool_name // empty')

if [ "$tool_name" != "Bash" ]; then
  exit 0
fi

command=$(echo "$input" | jq -r '.tool_input.command // empty')

if [ -z "$command" ]; then
  exit 0
fi

# This repo's own GitHub owner. Override via env var (space-separated for
# multiple owners) if needed; defaults to this project's actual owner.
OWN_OWNERS="${CLAUDE_OWN_GITHUB_OWNERS:-ishiharatma}"

# Switch to permissionDecision=ask, which routes the call to the confirmation dialog.
ask() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# --- Is this a gh write command? ---

is_gh_write=false

if echo "$command" | grep -qE 'gh[[:space:]]+(pr|issue)[[:space:]]+(create|comment|review|close|reopen|edit|merge|transfer|delete|lock)'; then
  is_gh_write=true
elif echo "$command" | grep -qE 'gh[[:space:]]+(release|gist)[[:space:]]+(create|edit|delete|upload)'; then
  is_gh_write=true
elif echo "$command" | grep -qE 'gh[[:space:]]+repo[[:space:]]+(delete|edit|rename|archive)'; then
  is_gh_write=true
elif echo "$command" | grep -qE 'gh[[:space:]]+api[[:space:]]'; then
  # Only inspect what follows "gh api" to avoid false positives from unrelated
  # flags earlier in the command (e.g. rm -f).
  api_seg=$(echo "$command" | sed -E 's/.*gh[[:space:]]+api[[:space:]]//')
  # Explicit write method, or field flags (which imply an implicit POST).
  if echo "$command" | grep -qE '(-X|--method)[= ][[:space:]]*(POST|PUT|PATCH|DELETE)'; then
    is_gh_write=true
  elif echo " $api_seg" | grep -qE '[[:space:]](-f|-F|--field|--raw-field|--input)[[:space:]=]'; then
    is_gh_write=true
  fi
fi

if [ "$is_gh_write" != "true" ]; then
  exit 0
fi

# --- Extract the target repository owner ---

# 1. -R / --repo flag
target=$(echo "$command" | grep -oE '(-R|--repo)[= ][[:space:]]*[^[:space:]]+' | head -1 | sed -E 's/^(-R|--repo)[= ][[:space:]]*//')
# 2. GitHub URL (matched by github.* to also cover GitHub Enterprise hosts)
if [ -z "$target" ]; then
  target=$(echo "$command" | grep -oE 'github\.[^/[:space:]]+/[^[:space:]"'\'']+' | head -1 | sed -E 's|^github\.[^/]+/||')
fi
# 3. gh api repos/<owner>/... path
if [ -z "$target" ]; then
  target=$(echo "$command" | grep -oE 'repos/[^/[:space:]"'\'']+/' | head -1 | sed 's|^repos/||')
fi
# 4. positional owner/repo argument (e.g. gh repo delete owner/repository)
#    Only search the part of the command starting at "gh" to avoid matching
#    unrelated paths (e.g. a preceding cd).
if [ -z "$target" ]; then
  gh_seg=$(echo "$command" | grep -oE 'gh[[:space:]].*' | head -1)
  target=$(echo "$gh_seg" | grep -oE '(^|[[:space:]])[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+' | head -1 | sed 's/^[[:space:]]*//')
fi

owner=$(echo "$target" | sed -E 's|^https?://[^/]+/||' | cut -d/ -f1 | tr -d '/')

# Only operations against this project's own repo pass through; anything
# else, or an unresolved target, goes to the confirmation dialog.
for own in $OWN_OWNERS; do
  if [ "$owner" = "$own" ]; then
    exit 0
  fi
done

ask "This may write to an external repository (target: ${owner:-unknown}). Please verify the destination and content."
