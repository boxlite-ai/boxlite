#!/usr/bin/env bash
# Bring up the full L1+L2 local stack.
#
# Behaves like an "ensure-running" — components already alive are skipped.
# All native processes go in background; logs to apps/infra-local/.logs/<comp>.log.
#
# Order:
#   1. L1 boxes (10) via `python -m boxlite_local up` (skipped if already up)
#   2. Schema load (idempotent — apply-schema.sh detects already-loaded)
#   3. API
#   4. Runner (depends on API for registration)
#   5. Proxy
#   6. Dashboard
#
# Usage: stack-up.sh [component...]   (default: all)

set -euo pipefail
. "$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/_stack-common.sh"

# ---------- Argument parsing ----------
COMPONENTS=("${@:-}")
if [ ${#COMPONENTS[@]} -eq 0 ] || [ -z "${COMPONENTS[0]}" ]; then
  COMPONENTS=("${ALL_COMPONENTS[@]}")
fi

# ---------- L1 boxes ----------
if ! boxlite ls 2>/dev/null | grep -q boxlite-local-postgres; then
  log "L1 boxes not running — starting..."
  ( cd "${INFRA_LOCAL_DIR}" && make up-with-schema )
else
  ok "L1 boxes already running"
fi

# ---------- Binaries present? ----------
for bin in "${RUNNER_BIN}" "${PROXY_BIN}"; do
  if [ ! -x "${bin}" ]; then
    log "missing ${bin} — running stack-build.sh"
    "${SCRIPT_DIR}/stack-build.sh"
    break
  fi
done

# ---------- Symlinks NestJS needs ----------
# apps/.env → apps/api/.env (NestJS reads .env from cwd=apps/)
[ -L "${APPS_DIR}/.env" ] || ln -sf api/.env "${APPS_DIR}/.env"
# apps/apps → . (webpack.config.js path resolution quirk)
[ -L "${APPS_DIR}/apps" ] || ln -sf . "${APPS_DIR}/apps"

# ---------- Component starters ----------
start_api() {
  if pid=$(component_pid api); [ -n "$pid" ]; then
    ok "api already running (PID $pid)"
    return
  fi
  # Defense against stale listeners from a crashed prior session.
  if port_listening "${PORT_API}"; then
    warn "port ${PORT_API} already in use — killing prior listener"
    lsof -ti :${PORT_API} -sTCP:LISTEN | xargs -r kill -9 2>/dev/null || true
    sleep 1
  fi
  log "starting api..."
  ( cd "${APPS_DIR}" && set -a && . ./.env && set +a && \
    nohup corepack yarn nx serve api > "$(log_file api)" 2>&1 & \
    echo $! > "$(pid_file api)" )
  if wait_http "http://localhost:${PORT_API}/api/health" 180; then
    ok "api up on :${PORT_API}"
  else
    err "api failed to become healthy in 180s — see $(log_file api)"
    return 1
  fi
}

start_runner() {
  if pid=$(component_pid runner); [ -n "$pid" ]; then
    ok "runner already running (PID $pid)"
    return
  fi
  if port_listening "${PORT_RUNNER}"; then
    warn "port ${PORT_RUNNER} already in use — killing prior listener"
    lsof -ti :${PORT_RUNNER} -sTCP:LISTEN | xargs -r kill -9 2>/dev/null || true
    sleep 1
  fi
  log "starting runner..."
  BOXLITE_API_URL=http://localhost:${PORT_API}/api \
  BOXLITE_RUNNER_TOKEN=local-shared-runner-token-aaaa1111 \
  API_VERSION=2 API_PORT=${PORT_RUNNER} \
  RUNNER_DOMAIN=127.0.0.1 \
  BOXLITE_HOME_DIR="${RUNNER_HOME}" \
  INSECURE_REGISTRIES=127.0.0.1:25000 \
  AWS_REGION=us-east-1 \
  DYLD_LIBRARY_PATH="${RUNNER_DYLIB_DIR}" \
  nohup "${RUNNER_BIN}" > "$(log_file runner)" 2>&1 &
  echo $! > "$(pid_file runner)"
  if wait_port "${PORT_RUNNER}" 60; then
    ok "runner up on :${PORT_RUNNER}"
  else
    err "runner failed to listen in 60s — see $(log_file runner)"
    return 1
  fi
}

start_proxy() {
  if pid=$(component_pid proxy); [ -n "$pid" ]; then
    ok "proxy already running (PID $pid)"
    return
  fi
  if port_listening "${PORT_PROXY}"; then
    warn "port ${PORT_PROXY} already in use — killing prior listener"
    lsof -ti :${PORT_PROXY} -sTCP:LISTEN | xargs -r kill -9 2>/dev/null || true
    sleep 1
  fi
  log "starting proxy..."
  PROXY_PORT=${PORT_PROXY} \
  PROXY_PROTOCOL=http \
  PROXY_API_KEY=boxlite-proxy-key \
  BOXLITE_API_URL=http://localhost:${PORT_API}/api \
  OIDC_CLIENT_ID=boxlite \
  OIDC_AUDIENCE=boxlite \
  OIDC_DOMAIN=http://localhost:25556/dex \
  REDIS_HOST=127.0.0.1 REDIS_PORT=26379 \
  SHUTDOWN_TIMEOUT_SEC=10 \
  nohup "${PROXY_BIN}" > "$(log_file proxy)" 2>&1 &
  echo $! > "$(pid_file proxy)"
  if wait_port "${PORT_PROXY}" 30; then
    ok "proxy up on :${PORT_PROXY}"
  else
    err "proxy failed to listen in 30s — see $(log_file proxy)"
    return 1
  fi
}

start_dashboard() {
  if pid=$(component_pid dashboard); [ -n "$pid" ]; then
    ok "dashboard already running (PID $pid)"
    return
  fi
  if port_listening "${PORT_DASHBOARD}"; then
    warn "port ${PORT_DASHBOARD} already in use — killing prior listener"
    lsof -ti :${PORT_DASHBOARD} -sTCP:LISTEN | xargs -r kill -9 2>/dev/null || true
    sleep 1
  fi
  log "starting dashboard (Vite dev)..."
  ( cd "${APPS_DIR}" && \
    nohup corepack yarn nx serve dashboard \
      > "$(log_file dashboard)" 2>&1 & \
    echo $! > "$(pid_file dashboard)" )
  if wait_http "http://localhost:${PORT_DASHBOARD}" 120; then
    ok "dashboard up on :${PORT_DASHBOARD}"
  else
    err "dashboard failed to become healthy in 120s — see $(log_file dashboard)"
    return 1
  fi
}

# ---------- Dispatch ----------
for comp in "${COMPONENTS[@]}"; do
  case "$comp" in
    api)       start_api ;;
    runner)    start_runner ;;
    proxy)     start_proxy ;;
    dashboard) start_dashboard ;;
    *) die "unknown component: $comp (valid: ${ALL_COMPONENTS[*]})" ;;
  esac
done

echo
ok "stack up — see status with: make stack-status"
echo "  Dashboard:    http://localhost:${PORT_DASHBOARD}"
echo "  API:          http://localhost:${PORT_API}/api"
echo "  Dex (OIDC):   http://localhost:25556/dex"
echo "  Logs at:      ${LOGS_DIR}/"
