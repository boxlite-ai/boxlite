#!/bin/sh
set -eu # Exit on missing variables or failed commands so startup fails visibly.

mkdir -p /workspace # Ensure the default working directory exists before the daemon starts.

if [ -z "${BOXLITE_BOX_ID:-}" ]; then
  BOXLITE_BOX_ID="${BOXLITE_SANDBOX_ID:-$(hostname)}" # Prefer legacy sandbox id, then hostname, for the daemon's required box id.
  export BOXLITE_BOX_ID # Make the fallback visible to boxlite-daemon.
fi

if [ -z "${BOXLITE_SANDBOX_ID:-}" ]; then
  BOXLITE_SANDBOX_ID="$BOXLITE_BOX_ID" # Keep legacy callers that still read BOXLITE_SANDBOX_ID working.
  export BOXLITE_SANDBOX_ID # Make the compatibility value visible to child processes.
fi

exec /boxlite/bin/boxlite-daemon "$@" # Replace the wrapper with the daemon so signals reach the real process.
