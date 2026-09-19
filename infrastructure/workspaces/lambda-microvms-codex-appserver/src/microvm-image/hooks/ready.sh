#!/bin/sh
# Image-build hook: microvmImageHooks.ready
# Invoked once during `create-microvm-image`, after the Dockerfile's
# container has started, to confirm the app is up before Lambda takes the
# Firecracker snapshot that every later RunMicrovm resumes from.
set -eu

PORT="${CODEX_APP_SERVER_PORT:?}"
ATTEMPTS=30

i=1
while [ "$i" -le "$ATTEMPTS" ]; do
  if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
    echo "[ready] codex app-server is accepting connections on port ${PORT}"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "[ready] codex app-server did not open port ${PORT} within ${ATTEMPTS}s" >&2
exit 1
