#!/bin/sh
# Runtime hook: microvmHooks.resume
# Invoked when the MicroVM transitions SUSPENDED -> RUNNING, either via
# auto-resume (idlePolicy.autoResumeEnabled + inbound traffic) or a caller
# invoking resume-microvm. codex app-server's process memory (including any
# in-flight Thread/Turn/Item state) resumes exactly where Firecracker paused
# it, so this hook is only a log checkpoint.
set -eu
echo "[resume] microvm resumed at $(date -u +%FT%TZ)" >>/tmp/codex-app-server.log
