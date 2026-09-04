#!/bin/sh
# Test that entrypoint.sh renders a SECURE production config by default:
# no static admin credential, no wildcard CORS; dev account only with the flag.
set -e
HERE=$(CDPATH= cd "$(dirname "$0")" && pwd)
CFG="$HERE/config.yaml"
HASH='HRQuAueS7JTT5ZHsHSzYiFPm1leZck7Mc8T4W'
fail() { echo "FAIL: $1" >&2; exit 1; }

# --- prod default (flag unset): static password DB disabled ---
OUT=$(mktemp)
DEX_CONFIG_PATH="$CFG" DEX_RENDERED_CONFIG_PATH="$OUT" DEX_BIN=/bin/true sh "$HERE/entrypoint.sh"
grep -q "enablePasswordDB: false" "$OUT" || fail "prod render missing 'enablePasswordDB: false'"
grep -q "$HASH" "$OUT" && fail "prod render LEAKS the static admin credential"
grep -qF "allowedOrigins: ['*']" "$OUT" && fail "prod render still has wildcard CORS"
grep -q "allowedOrigins:" "$OUT" || fail "prod render dropped allowedOrigins"

# --- dev opt-in (flag=true): static account present ---
OUT2=$(mktemp)
DEX_ENABLE_STATIC_PASSWORD=true DEX_CONFIG_PATH="$CFG" DEX_RENDERED_CONFIG_PATH="$OUT2" DEX_BIN=/bin/true sh "$HERE/entrypoint.sh"
grep -q "$HASH" "$OUT2" || fail "dev opt-in render missing the static admin credential"
grep -q "enablePasswordDB: true" "$OUT2" || fail "dev opt-in render missing enablePasswordDB: true"

echo "PASS: entrypoint render (prod secure-by-default, dev opt-in)"
