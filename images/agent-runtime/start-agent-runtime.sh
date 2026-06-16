#!/bin/sh
set -eu

mkdir -p /workspace

if [ -z "${BOXLITE_BOX_ID:-}" ]; then
  BOXLITE_BOX_ID="${BOXLITE_SANDBOX_ID:-$(hostname)}"
  export BOXLITE_BOX_ID
fi

if [ -z "${BOXLITE_SANDBOX_ID:-}" ]; then
  BOXLITE_SANDBOX_ID="$BOXLITE_BOX_ID"
  export BOXLITE_SANDBOX_ID
fi

exec /boxlite/bin/boxlite-daemon "$@"
