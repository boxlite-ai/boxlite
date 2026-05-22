#!/usr/bin/env bash
# Wipe L2 runtime state. Keeps L1 boxes alive (db schema preserved by default).
#
# Usage: stack-reset.sh             # stop L2, truncate PG user data, wipe runner home
#        stack-reset.sh --hard      # also wipe PG schema (re-applies prod baseline)
#        stack-reset.sh --nuke      # everything: --hard + L1 boxes + .logs

set -euo pipefail
. "$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/_stack-common.sh"

MODE="soft"
case "${1:-}" in
  --hard) MODE="hard" ;;
  --nuke) MODE="nuke" ;;
  ""    ) MODE="soft" ;;
  *) die "unknown flag: $1 (valid: --hard --nuke)" ;;
esac

log "stopping L2 native processes..."
"${SCRIPT_DIR}/stack-down.sh"

log "wiping runner home: ${RUNNER_HOME}"
rm -rf "${RUNNER_HOME}"/{db,boxes,images,rootfs,logs} 2>/dev/null || true

if [ "$MODE" = "soft" ]; then
  if boxlite ls 2>/dev/null | grep -q boxlite-local-postgres; then
    log "truncating user data tables (schema preserved)..."
    # CASCADE follows FKs; including "user" forces orgs/members/sandboxes
    # to drop too. We deliberately NOT preserve the boxlite-admin row
    # so that the API's `initializeAdminUser()` re-runs on next boot
    # and rebuilds the admin user → personal org → api key chain.
    # (Otherwise stale admin user blocks the seed cycle — see
    # seed-init-data.sh comments.)
    PGPASSWORD=boxlite psql -h 127.0.0.1 -p 25432 -U boxlite -d boxlite -v ON_ERROR_STOP=1 -c "
      TRUNCATE TABLE \"user\", sandbox, snapshot, snapshot_runner, runner, region,
                     organization, organization_user, organization_role,
                     api_key, audit_log RESTART IDENTITY CASCADE;
    " 2>&1 | tail -2 || warn "truncate had errors (some tables may not exist on fresh schema)"
  else
    warn "PG not running — skipping data truncate"
  fi
  ok "soft reset complete (L1 boxes + schema preserved)"
  log "next: \`make stack-up\` — API will auto-seed all base data + wait for default snapshot"
elif [ "$MODE" = "hard" ]; then
  if boxlite ls 2>/dev/null | grep -q boxlite-local-postgres; then
    log "wiping schema + reloading prod baseline..."
    PGPASSWORD=boxlite psql -h 127.0.0.1 -p 25432 -U boxlite -d boxlite -c "
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO boxlite;
    " > /dev/null
    ( cd "${INFRA_LOCAL_DIR}" && make load-schema )
  else
    warn "PG not running — skipping schema reload"
  fi
  ok "hard reset complete (L1 boxes alive, schema rebuilt)"
  log "next: \`make stack-up\` — API will auto-seed all base data + wait for default snapshot"
else
  log "nuking everything (L1 boxes + data + logs)..."
  ( cd "${INFRA_LOCAL_DIR}" && make wipe )
  rm -rf "${LOGS_DIR}"
  ok "nuke complete — next stack-up will be a true cold start"
fi
