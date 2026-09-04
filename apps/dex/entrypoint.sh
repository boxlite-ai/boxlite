#!/bin/sh
set -e

# Simple string replacement for env vars in config.
# Paths and the dex binary are overridable so the rendering can be tested.
CONFIG="${DEX_CONFIG_PATH:-/etc/dex/config.yaml}"
TMP="${DEX_RENDERED_CONFIG_PATH:-/tmp/dex-config.yaml}"
DEX_BIN="${DEX_BIN:-/usr/local/bin/dex}"

# Default CORS origins to the local dev origins, never '*'. Operators set
# DEX_ALLOWED_ORIGINS (a YAML list literal) to their dashboard origin in prod.
DEX_ALLOWED_ORIGINS="${DEX_ALLOWED_ORIGINS:-['http://localhost:3000','http://localhost:5173','http://127.0.0.1:5555']}"

cat "$CONFIG" | \
  sed "s|\${DEX_ISSUER}|${DEX_ISSUER:-http://localhost:5556/dex}|g" | \
  sed "s|\${REDIRECT_URI}|${REDIRECT_URI:-http://localhost:3000}|g" | \
  sed "s|\${DEX_ALLOWED_ORIGINS}|${DEX_ALLOWED_ORIGINS}|g" \
  > "$TMP"

# Static password DB is OFF by default (no admin@boxlite.dev login ships). Enable
# the dev account only when explicitly requested via DEX_ENABLE_STATIC_PASSWORD=true.
if [ "${DEX_ENABLE_STATIC_PASSWORD}" = "true" ]; then
  echo "WARNING: DEX_ENABLE_STATIC_PASSWORD=true — enabling the static admin@boxlite.dev account (development only)" >&2
  # Quoted heredoc: the bcrypt hash contains literal '$' and must not be expanded.
  cat >> "$TMP" <<'STATIC_PW'
enablePasswordDB: true
staticPasswords:
  - email: 'admin@boxlite.dev'
    # password: password
    hash: '$2a$10$2b2cU8CPhOTaGrs1HRQuAueS7JTT5ZHsHSzYiFPm1leZck7Mc8T4W'
    username: 'admin'
    userID: '1234'
STATIC_PW
else
  echo "enablePasswordDB: false" >> "$TMP"
fi

exec "$DEX_BIN" serve "$TMP"
