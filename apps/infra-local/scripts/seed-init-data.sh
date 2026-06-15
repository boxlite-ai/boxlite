#!/usr/bin/env bash
# Wait for the API's auto-seed cycle to complete after a fresh start
# or stack-reset.
#
# The API self-seeds all base data at boot via app.service.ts
# `onApplicationBootstrap()`:
#   1. initializeDefaultRegion       → region 'us'
#   2. initializeAdminUser           → boxlite-admin user + Personal org
#                                      + organization_user + admin API key
#   3. initialize{Internal,Backup,Transient}Registry
#   4. initializeDefaultRunner       → 'local-m5' DB row (async)
#   5. default runner registration   → runner row via heartbeat
#
# Each step has "skip if exists" guards. As long as the related tables
# were truncated (`stack-reset` does this), the API re-seeds from scratch.
#
# This script's only job: ensure the API is running, restart it if a
# stale state could have left auto-seed incomplete, and wait for the
# default runner to register (boxes can't schedule without one).
#
# Idempotent: re-running is safe.

set -euo pipefail
. "$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/_stack-common.sh"

PSQL_BASE=(env PGPASSWORD=boxlite psql -h 127.0.0.1 -p 25432 -U boxlite -d boxlite)
PSQL=("${PSQL_BASE[@]}" -v ON_ERROR_STOP=1 -tA)

require_pg() {
  if ! "${PSQL[@]}" -c "SELECT 1" > /dev/null 2>&1; then
    die "postgres not reachable at 127.0.0.1:25432 — bring up L1 first (make up)"
  fi
}

verify_api_seeded() {
  # Sanity check that initializeAdminUser ran. If admin user is missing,
  # API is either not started yet or its onApplicationBootstrap hasn't
  # finished yet.
  local has_admin_user
  has_admin_user=$("${PSQL[@]}" -c "SELECT count(*) FROM \"user\" WHERE id = 'boxlite-admin';" || echo "0")
  if [ "$has_admin_user" -gt 0 ]; then
    ok "admin user present (API auto-seed completed)"
  else
    warn "admin user missing — is the API running?"
    return 1
  fi
  local has_admin_org
  # The `personal` org column was dropped in the pre-launch schema squash
  # (#736); the API now seeds a "Default Organization" owned by the admin.
  has_admin_org=$("${PSQL[@]}" -c "
    SELECT count(*) FROM organization
    WHERE \"createdBy\" = 'boxlite-admin';
  " || echo "0")
  if [ "$has_admin_org" -gt 0 ]; then
    ok "admin org present"
  else
    warn "admin org missing — API initializeAdminUser may have failed"
    return 1
  fi
  local has_region
  has_region=$("${PSQL[@]}" -c "SELECT count(*) FROM region WHERE id = 'us';" || echo "0")
  if [ "$has_region" -gt 0 ]; then
    ok "default region 'us' present"
  else
    warn "default region missing"
    return 1
  fi
  return 0
}

# Trigger the API to re-run its initialize* cycle if it's running. The
# guards inside the API skip work that's already done, so this is cheap
# when the seed is already complete.
bounce_api_if_running() {
  local pid
  pid="$(component_pid api || true)"
  if [ -n "$pid" ]; then
    log "restarting api so it re-runs initialize* cycle..."
    "${SCRIPT_DIR}/stack-restart.sh" api
  else
    log "api not running — skipping restart (seed will run on next stack-up)"
  fi
}

# Verify the default runner registered (the API seeds it; boxes can't be
# scheduled without one). Snapshots/templates no longer exist post-squash
# (#736): boxes are created directly from images, so there is no pre-pull
# phase to wait for anymore.
wait_for_default_runner() {
  local timeout=60
  local elapsed=0
  log "waiting for the default runner to register..."
  while true; do
    local count
    count=$("${PSQL[@]}" -c "SELECT count(*) FROM runner;" 2>/dev/null || echo "0")
    [ "${count:-0}" -gt 0 ] && { ok "runner registered"; return 0; }
    sleep 2
    elapsed=$((elapsed + 2))
    if [ "$elapsed" -ge "$timeout" ]; then
      warn "no runner row after ${timeout}s — check runner logs"
      return 1
    fi
  done
}

# ---------- Main ----------
require_pg

if [ "${1:-}" = "--no-bounce" ]; then
  log "skipping API bounce (--no-bounce); assuming API just woke + is running its boot cycle"
else
  bounce_api_if_running
fi

# After potential bounce, wait briefly for the API auto-seed cycle to
# write the admin user + org rows.
log "waiting for API auto-seed to land admin user + org..."
elapsed=0
while ! verify_api_seeded 2>/dev/null; do
  sleep 2
  elapsed=$((elapsed + 2))
  if [ "$elapsed" -ge 60 ]; then
    err "API never seeded admin user/org in 60s — check api log"
    exit 1
  fi
done

if [ "${1:-}" = "--no-wait" ] || [ "${2:-}" = "--no-wait" ]; then
  log "skipping runner wait (--no-wait)"
else
  wait_for_default_runner || warn "runner not registered — box create will fail until it is"
fi

ok "init data ready"
