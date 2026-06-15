#!/usr/bin/env bash
# Wipe L2 runtime state. Keeps L1 boxes alive (db schema preserved by default).
#
# Usage: stack-reset.sh             # clear boxes/jobs/volumes, KEEP users+orgs
#                                     → browser stays logged in, no re-login
#        stack-reset.sh --hard      # wipe PG schema entirely (rebuilds it by
#                                     re-running migrations) → identity gone, re-login needed
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
    log "truncating runtime data (identity + infra rows preserved)..."
    # PRESERVE identity + infra so an already-logged-in browser session
    # stays valid across a reset (no forced re-login):
    #   user, organization + its FK children (organization_user, roles,
    #   assignments, invitations), region, runner, api_key,
    #   warm_pool (pool config, not runtime state)
    # CLEAR only runtime/user-created state:
    #   box (+ CASCADE children box_last_activity, ssh_access), job,
    #   volume, audit_log. The runner re-registers via heartbeat
    #   (matched by apiKey).
    #
    # Why preserve user+org TOGETHER: a half-state (user kept, org dropped)
    # strands initializeAdminUser's early-exit guard. Keeping both keeps
    # the seed cycle consistent AND keeps OIDC sessions alive. For a true
    # from-scratch identity wipe use --hard.
    PGPASSWORD=boxlite psql -h 127.0.0.1 -p 25432 -U boxlite -d boxlite -v ON_ERROR_STOP=1 -c "
      TRUNCATE TABLE box, job, volume, audit_log
                     RESTART IDENTITY CASCADE;
    " 2>&1 | tail -2 || warn "truncate had errors (some tables may not exist on fresh schema)"
  else
    warn "PG not running — skipping data truncate"
  fi
  ok "soft reset complete (identity + L1 boxes + schema preserved — no browser re-login needed)"
  log "next: \`make stack-up\` — runner re-registers via heartbeat"
elif [ "$MODE" = "hard" ]; then
  if boxlite ls 2>/dev/null | grep -q boxlite-local-postgres; then
    log "wiping schema + rebuilding via migrations..."
    PGPASSWORD=boxlite psql -h 127.0.0.1 -p 25432 -U boxlite -d boxlite -c "
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO boxlite;
    " > /dev/null
    ( cd "${INFRA_LOCAL_DIR}" && make migrate )
  else
    warn "PG not running — skipping schema rebuild"
  fi
  ok "hard reset complete (L1 boxes alive, schema rebuilt — identity wiped)"
  warn "browser must re-login: clear sessionStorage + localStorage, then sign in via dex"
  log "next: \`make stack-up\` — API will auto-seed all base data on boot"
else
  log "nuking everything (L1 boxes + data + logs)..."
  ( cd "${INFRA_LOCAL_DIR}" && make wipe )
  rm -rf "${LOGS_DIR}"
  ok "nuke complete — next stack-up will be a true cold start"
fi
