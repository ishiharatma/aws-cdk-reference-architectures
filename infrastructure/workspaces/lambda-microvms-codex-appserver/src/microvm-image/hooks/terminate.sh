#!/bin/sh
# Runtime hook: microvmHooks.terminate
# Invoked when the MicroVM is about to be torn down permanently (caller
# invoked terminate-microvm, or maximumDurationInSeconds was reached).
# Best-effort graceful shutdown of codex app-server before the platform
# reclaims the Firecracker VM.
set -eu
if [ -f /tmp/codex-app-server.pid ]; then
  kill "$(cat /tmp/codex-app-server.pid)" 2>/dev/null || true
fi
echo "[terminate] microvm terminating at $(date -u +%FT%TZ)" >>/tmp/codex-app-server.log
