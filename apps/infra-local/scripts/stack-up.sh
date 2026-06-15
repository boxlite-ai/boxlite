#!/usr/bin/env bash
# Bring up the full L1+L2 local stack.
#
# Behaves like an "ensure-running" — components already alive are skipped.
# All native processes go in background; logs to <repo>/.apps-local/logs/<comp>.log.
#
# Order:
#   1. L1 boxes (10) via `python -m boxlite_local up` (skipped if already up)
#   2. API — runs all TypeORM migrations on boot against the empty pg
#           (NODE_ENV=development → migrationsRun=true; no schema baseline)
#   3. Runner (depends on API for registration)
#   4. Proxy
#   5. Dashboard
#
# Usage: stack-up.sh [component...]   (default: all)

set -euo pipefail
. "$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/_stack-common.sh"

# ---------- Argument parsing ----------
COMPONENTS=("${@:-}")
if [ ${#COMPONENTS[@]} -eq 0 ] || [ -z "${COMPONENTS[0]}" ]; then
  COMPONENTS=("${ALL_COMPONENTS[@]}")
fi

# ---------- Orchestrator package installed? ----------
# Bringing up L1 calls `python -m boxlite_local` (via make up).
# On a fresh Python env that module isn't importable yet — auto-install
# instead of failing. Conditional: the common restart path (already
# installed) pays nothing, so `make stack-up` works from zero or on a
# restart without ever needing a manual `make install` first.
if ! "${PY:-python}" -c "import boxlite_local" 2>/dev/null; then
  log "boxlite_local not importable — running make install"
  ( cd "${INFRA_LOCAL_DIR}" && make install )
fi

# ---------- L1 boxes ----------
L1_RECREATED=false
if ! boxlite ls 2>/dev/null | grep -q boxlite-local-postgres; then
  log "L1 boxes not running — starting..."
  ( cd "${INFRA_LOCAL_DIR}" && make up )
  L1_RECREATED=true
else
  ok "L1 boxes already running"
fi

# A surviving L2 process is stale once L1 has just been (re)created: it holds
# connections to the destroyed-and-recreated DB and — critically for the API —
# already ran its onApplicationBootstrap seed against the OLD database, so it
# will NOT re-seed the fresh one (no admin user/org/region → dead dashboard).
# `make down`/`wipe` already stop L2, but bypass paths (stack-rebuild-l1-box,
# direct `boxlite rm`, `python -m boxlite_local down`) don't. Stop any stale L2
# for the components we're about to start so the starters below bring them up
# fresh against the new L1. No-op when L2 is already down (the common case).
if [ "${L1_RECREATED}" = "true" ]; then
  log "L1 (re)created — stopping any stale L2 procs so they restart fresh"
  "${SCRIPT_DIR}/stack-down.sh" "${COMPONENTS[@]}" || true
fi

# ---------- Binaries present? ----------
# stack-up auto-builds missing binaries (fresh checkout, or .apps-local/bin
# wiped). It does NOT rebuild a binary that already exists — to pick up
# source changes use `make stack-restart COMPONENTS=runner` (which rebuilds).
for bin in "${RUNNER_BIN}" "${PROXY_BIN}"; do
  if [ ! -x "${bin}" ]; then
    log "missing ${bin} — running stack-build.sh"
    "${SCRIPT_DIR}/stack-build.sh"
    break
  fi
done

# ---------- API .env (local-stack config) ----------
# apps/api/.env is gitignored (prod holds real secrets there), so a fresh
# clone has no file for the symlink below to point at. Seed it from the
# checked-in local-stack template on first run; never clobber a dev's edits.
if [ ! -f "${APPS_DIR}/api/.env" ]; then
  log "apps/api/.env missing — seeding from infra-local template"
  cp "${INFRA_LOCAL_DIR}/configs/api.env" "${APPS_DIR}/api/.env"
fi

# ---------- Symlinks NestJS needs ----------
# apps/.env → apps/api/.env (NestJS reads .env from cwd=apps/)
[ -L "${APPS_DIR}/.env" ] || ln -sf api/.env "${APPS_DIR}/.env"

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
  # M5-native dev override: the Go runner reports system-wide CPU / memory /
  # disk usage (the whole Mac), not just what the runner + its boxes
  # actually own. On a dev laptop sharing RAM with VS Code, Chrome, Docker
  # Desktop, and the L1 dev stack itself, those metrics easily push the
  # runner's availabilityScore below the prod-default threshold of 10,
  # and the API rejects box-create with "No available runners" — even
  # though the runner is actually idle. The overrides below relax the
  # penalty thresholds + lower the availability cutoff so a single-runner
  # dev box stays schedulable. Safe because there's only one runner here
  # and the autoscaler is not in play.
  #   - RUNNER_AVAILABILITY_SCORE_THRESHOLD=5   (prod default 10)
  #   - RUNNER_MEMORY_PENALTY_THRESHOLD=95      (prod default 75)
  #   - RUNNER_DISK_PENALTY_THRESHOLD=95        (prod default 75)
  # Set BEFORE sourcing apps/.env so anything explicitly set there still
  # wins (set -a + . ./.env exports .env values).
  # (generatePackageJson=false / skipTypeChecking=true now live in
  # apps/api/project.json — no serve-time overrides needed.)
  ( cd "${APPS_DIR}" && \
    export RUNNER_AVAILABILITY_SCORE_THRESHOLD=5 \
           RUNNER_MEMORY_PENALTY_THRESHOLD=95 \
           RUNNER_DISK_PENALTY_THRESHOLD=95 && \
    set -a && . ./.env && set +a && \
    nohup corepack yarn nx serve api \
      > "$(log_file api)" 2>&1 & \
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
  # VITE_API_URL=/api tells dashboard API calls to use the Vite dev
  # proxy (configured in vite.config.mts to forward /api → localhost:3001)
  # rather than the hard-coded prod default `https://app.boxlite.io/api`.
  # Without this, dashboard create-box calls escape to prod
  # and fail with ERR_CONNECTION_CLOSED.
  ( cd "${APPS_DIR}" && \
    VITE_API_URL=/api nohup corepack yarn nx serve dashboard \
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
# If api + runner just started, ensure init data is in place + wait for
# the runner to register. This is the chain the dashboard needs to
# schedule a box at all — without a registered runner the first
# box-create 400s ("No available runners"). Idempotent — skips work
# that's done.
case " ${COMPONENTS[*]} " in
  *" api "*|*" runner "*)
    log "ensuring init data + registered runner..."
    # --no-bounce: api is already alive and we just woke it up;
    # restarting again would be wasteful.
    "${SCRIPT_DIR}/seed-init-data.sh" --no-bounce || warn "init-data seed reported issues — see output above"
    ;;
esac

ok "stack up — see status with: make stack-status"
echo "  Dashboard:    http://localhost:${PORT_DASHBOARD}"
echo "  API:          http://localhost:${PORT_API}/api"
echo "  Dex (OIDC):   http://localhost:25556/dex"
echo "  Logs at:      ${LOGS_DIR}/"
