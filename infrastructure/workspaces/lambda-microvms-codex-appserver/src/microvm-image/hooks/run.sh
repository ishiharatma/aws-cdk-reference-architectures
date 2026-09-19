#!/bin/sh
# Runtime hook: microvmHooks.run
# Invoked once, when a MicroVM launched via RunMicrovm transitions from
# PENDING to RUNNING. Starts `codex app-server` listening on the WebSocket
# transport so the client can connect directly to the MicroVM's dedicated
# HTTPS endpoint (see RunMicrovmResponse.endpoint) once RunMicrovm returns.
set -eu

mkdir -p "${CODEX_HOME:?}"

# Resolve the OpenAI API key from Secrets Manager using the credentials the
# platform injects for the MicroVM's execution role. OPENAI_API_KEY_SECRET_ARN
# is a fixed environment variable baked into the image by CfnMicrovmImage
# (same secret ARN for every session); the secret's value is never stored in
# the image itself.
if [ -n "${OPENAI_API_KEY_SECRET_ARN:-}" ]; then
  OPENAI_API_KEY="$(node /opt/hooks/fetch-secret.mjs "${OPENAI_API_KEY_SECRET_ARN}")"
  export OPENAI_API_KEY
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "[run] WARNING: OPENAI_API_KEY is not set; codex app-server will fail to authenticate" >&2
fi

nohup codex app-server \
  --listen "ws://0.0.0.0:${CODEX_APP_SERVER_PORT:?}" \
  >/tmp/codex-app-server.log 2>&1 &

echo $! >/tmp/codex-app-server.pid
echo "[run] codex app-server started (pid=$(cat /tmp/codex-app-server.pid)) at $(date -u +%FT%TZ)" >>/tmp/codex-app-server.log
