#!/usr/bin/env bash
# Restart one or more L2 components. For runner, also rebuilds the binary
# first (no watch mode for native Go). Other components have hot reload
# (Vite for dashboard, ts watch for api) so a restart is rarely needed
# — but useful when changing .env or non-source config.
#
# Usage: stack-restart.sh <component>...
#        stack-restart.sh runner         # rebuild + restart
#        stack-restart.sh api dashboard  # just bounce

set -euo pipefail
. "$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/_stack-common.sh"

[ $# -gt 0 ] || die "usage: stack-restart.sh <component>..."

for comp in "$@"; do
  case "$comp" in
    api|proxy|dashboard)
      "${SCRIPT_DIR}/stack-down.sh" "$comp"
      "${SCRIPT_DIR}/stack-up.sh"   "$comp"
      ;;
    runner)
      "${SCRIPT_DIR}/stack-down.sh" runner
      log "rebuilding runner binary..."
      ( cd "${APPS_DIR}/runner" && GOTOOLCHAIN=auto go build -o "${RUNNER_BIN}" ./cmd/runner )
      "${SCRIPT_DIR}/stack-up.sh"   runner
      ;;
    *) die "unknown component: $comp (valid: api runner proxy dashboard)" ;;
  esac
done
