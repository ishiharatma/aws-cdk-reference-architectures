#!/bin/sh
# Runtime hook: microvmHooks.suspend
# Invoked when the MicroVM transitions RUNNING -> SUSPENDING, either because
# it went idle (idlePolicy) or a caller invoked suspend-microvm. Firecracker
# itself snapshots process memory (so codex app-server's open
# Thread/Turn/Item state survives untouched); this hook only needs to flush
# state the app keeps outside process memory before the pause.
set -eu
echo "[suspend] microvm suspending at $(date -u +%FT%TZ)" >>/tmp/codex-app-server.log
sync
