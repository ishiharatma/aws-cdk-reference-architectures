#!/bin/sh
# Lambda gives a read-only filesystem except /tmp and runs as a non-root user,
# so every runtime path (pid, temp, sessions) points at /tmp.
set -e

mkdir -p /tmp/nginx /tmp/sessions

php-fpm --daemonize
exec nginx -e /dev/stderr -g 'daemon off;'
