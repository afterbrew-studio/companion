#!/bin/sh
set -e

# Container start-up, in the order the daemon needs it. Everything here is
# idempotent: a restart or a redeploy must be a no-op, not a re-initialisation.

: "${COMPANION_HOME:=/data}"
: "${COMPANION_HOST:=0.0.0.0}"
: "${COMPANION_PORT:=8901}"
: "${COMPANION_AUTH_MODE:=password}"
export COMPANION_HOME COMPANION_HOST COMPANION_PORT COMPANION_AUTH_MODE

mkdir -p "$COMPANION_HOME"

# moxxy keeps its provider credentials in its own home, which is a separate
# volume. Companion's isolated home symlinks to it, so losing that mount is how
# a redeploy loses every AI provider. Fail loudly rather than silently starting
# an instance whose agents cannot run.
if [ ! -d /root/.moxxy ]; then
  echo "warning: /root/.moxxy is not mounted; moxxy provider credentials will not survive a redeploy" >&2
fi

# The SPA is served from the bundle, not from a separate web server.
export COMPANION_STATIC_DIR="${COMPANION_STATIC_DIR:-/app/dist/web}"

if [ -n "$COMPANION_ADMIN_USER" ] && [ -z "$COMPANION_ADMIN_PASSWORD" ]; then
  echo "error: COMPANION_ADMIN_USER is set without COMPANION_ADMIN_PASSWORD" >&2
  exit 1
fi

# Optional entitlement file, mounted read-only by whoever deploys the enterprise
# image. Absent on every OSS install, which is the normal case.
if [ -n "$COMPANION_LICENSE_FILE" ] && [ -f "$COMPANION_LICENSE_FILE" ]; then
  cp "$COMPANION_LICENSE_FILE" "$COMPANION_HOME/license.jwt"
fi

# exec, so the daemon is PID 1 and receives SIGTERM directly: the kernel's
# shutdown path (onDisable for every module, in reverse dependency order) only
# runs if the signal reaches node rather than the shell.
exec node /app/dist/server.js "$@"
