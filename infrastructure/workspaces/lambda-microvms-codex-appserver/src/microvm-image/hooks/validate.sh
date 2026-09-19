#!/bin/sh
# Image-build hook: microvmImageHooks.validate
# Invoked once during `create-microvm-image`, after the Firecracker snapshot
# has been taken, to confirm the snapshot itself boots into a working state
# before Lambda marks the MicroVM image version ACTIVE. Reuses the same
# readiness check as the pre-snapshot `ready` hook: the snapshot is a memory
# + disk image of the same booted container, so an open app-server port is
# sufficient evidence that resume-from-snapshot works end to end.
set -eu
exec /opt/hooks/ready.sh
