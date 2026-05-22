#!/usr/bin/env bash
# Build the two native Go binaries that L2 needs:
#   - /tmp/boxlite-runner  (apps/runner)
#   - /tmp/boxlite-proxy   (apps/proxy)
#
# Also runs `yarn install` if node_modules is missing. Idempotent.

set -euo pipefail
. "$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/_stack-common.sh"

log "building native binaries..."

if [ ! -d "${APPS_DIR}/node_modules" ]; then
  log "yarn install (node_modules missing)"
  ( cd "${APPS_DIR}" && corepack yarn install )
fi

log "go build runner → ${RUNNER_BIN}"
( cd "${APPS_DIR}/runner" && GOTOOLCHAIN=auto go build -o "${RUNNER_BIN}" ./cmd/runner )

log "go build proxy  → ${PROXY_BIN}"
( cd "${APPS_DIR}/proxy" && GOTOOLCHAIN=auto go build -o "${PROXY_BIN}" ./cmd/proxy )

ok "binaries ready"
ls -l "${RUNNER_BIN}" "${PROXY_BIN}"
