#!/bin/sh
set -eu

mkdir -p /workspace

if [ -z "${BOXLITE_SANDBOX_ID:-}" ]; then
  BOXLITE_SANDBOX_ID="$(hostname)"
  export BOXLITE_SANDBOX_ID
fi

exec /boxlite/bin/boxlite-daemon "$@"
