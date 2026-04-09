#!/bin/sh
set -e

# Simple string replacement for env vars in config
CONFIG=/etc/dex/config.yaml
TMP=/tmp/dex-config.yaml

cat "$CONFIG" | \
  sed "s|\${DEX_ISSUER}|${DEX_ISSUER:-http://localhost:5556/dex}|g" | \
  sed "s|\${REDIRECT_URI}|${REDIRECT_URI:-http://localhost:3000}|g" \
  > "$TMP"

exec /usr/local/bin/dex serve "$TMP"
