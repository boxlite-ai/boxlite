#!/usr/bin/env bash
#
# Reproduce, on the running infra-local stack, the two ways the box usage ledger
# can drift away from the box table:
#
#   lost-start <box>   the API dies after the box row commits STARTED but before
#                      UsageService opens the period  -> the box runs unbilled
#   lost-stop  <box>   the API dies after the box row commits STOPPED but before
#                      UsageService closes the period -> the box bills compute
#                      while stopped
#
# Both are the same window. BoxRepository commits the row and only then calls
# emitUpdateEvents(), an in-process EventEmitter2 emit that is not awaited, not
# persisted and not retried; UsageService is the only listener that writes the
# ledger. The scenario holds that window open on purpose — it takes
# UsageService's own per-box Redis lock first, which parks the handler at its
# first await — and then SIGKILLs the API while the handler sits there.
#
# Usage:
#   ./usage-crash-scenario.sh audit                 # just report ledger drift
#   ./usage-crash-scenario.sh lost-start <box>      # box must be stopped
#   ./usage-crash-scenario.sh lost-stop  <box>      # box must be started
#   ./usage-crash-scenario.sh key                   # print the scenario API key
#   ./usage-crash-scenario.sh cleanup               # revoke that key
#
# <box> is a box name or id in the local database.
#
# Leave the box alone for the duration: the drift is only observable while the
# box sits in the state it crashed into, so a dashboard tab that stops it, or
# the API's watch mode reloading because a file under apps/api/src changed, will
# quietly repair it before the audit runs.
#
# Local stack only: it mints an API key straight into the database and SIGKILLs
# a process by pid file. Never point it at a shared environment.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INFRA_LOCAL="$(dirname -- "$SCRIPT_DIR")"
REPO_ROOT="$(cd -- "$INFRA_LOCAL/../.." && pwd)"
STATE_DIR="$REPO_ROOT/.apps-local"
API_PID_FILE="$STATE_DIR/logs/api.pid"
KEY_FILE="$STATE_DIR/usage-crash-scenario.key"
AUDIT_SQL="$SCRIPT_DIR/usage-ledger-audit.sql"

PGHOST=127.0.0.1 PGPORT=25432 PGUSER=boxlite PGPASSWORD=boxlite PGDATABASE=boxlite
export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
REDIS_HOST=127.0.0.1 REDIS_PORT=26379
export REDIS_HOST REDIS_PORT   # the node Redis client below reads them from its environment
API_URL=http://localhost:3001

# UsageService.aquireLock builds this key; parking it from outside is what holds
# the window open. Keep in step with usage.service.ts if that name ever changes.
usage_lock_key() { echo "usage-period-$1"; }

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

q() { psql -qtAX -c "$1"; }

# Minimal Redis client — the host has no redis-cli, and the local Redis runs
# inside an L1 microVM rather than a container we could exec into.
redis() {
  node -e '
    const net = require("net")
    const args = process.argv.slice(1)
    const cmd = "*" + args.length + "\r\n" + args.map((a) => "$" + Buffer.byteLength(a) + "\r\n" + a + "\r\n").join("")
    const socket = net.createConnection(Number(process.env.REDIS_PORT), process.env.REDIS_HOST)
    socket.on("connect", () => socket.write(cmd))
    socket.on("data", (chunk) => { process.stdout.write(chunk.toString().trim()); socket.end() })
    socket.on("error", (err) => { console.error(err.message); process.exit(1) })
  ' "$@"
}

require_tools() {
  for tool in psql node curl; do
    command -v "$tool" >/dev/null || die "$tool not found on PATH"
  done
  q 'SELECT 1' >/dev/null 2>&1 || die "no Postgres at $PGHOST:$PGPORT — is the stack up? (make status)"
  [ "$(redis PING)" = "+PONG" ] || die "no Redis at $REDIS_HOST:$REDIS_PORT"
}

# ---------------------------------------------------------------- API key

# Mints a key for the organization that owns the target box, so the REST call
# passes the organization guard. Cached in the gitignored state dir; re-minted
# whenever the cache is missing or the row no longer matches.
ensure_api_key() {
  local org="$1" user token hash
  user="$(q "SELECT \"userId\" FROM organization_user WHERE \"organizationId\" = '$org' AND role = 'owner' LIMIT 1")"
  [ -n "$user" ] || die "organization $org has no owner to mint a key for"

  if [ -f "$KEY_FILE" ]; then
    token="$(cat "$KEY_FILE")"
    hash="$(printf '%s' "$token" | shasum -a 256 | cut -d' ' -f1)"
    if [ "$(q "SELECT count(*) FROM api_key WHERE \"keyHash\" = '$hash' AND \"organizationId\" = '$org'")" = "1" ]; then
      echo "$token"
      return
    fi
  fi

  token="blk_test_$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
  hash="$(printf '%s' "$token" | shasum -a 256 | cut -d' ' -f1)"
  q "INSERT INTO api_key (\"organizationId\", \"userId\", name, \"keyHash\", \"keyPrefix\", \"keySuffix\", permissions, \"createdAt\")
     SELECT '$org', '$user', 'usage-crash-scenario', '$hash', 'blk_test_', '${token: -4}',
            enum_range(NULL::api_key_permissions_enum), now()
     ON CONFLICT (\"organizationId\", \"userId\", name)
     DO UPDATE SET \"keyHash\" = EXCLUDED.\"keyHash\", \"keySuffix\" = EXCLUDED.\"keySuffix\"" >/dev/null
  umask 077 && printf '%s' "$token" > "$KEY_FILE"
  echo "$token"
}

# ---------------------------------------------------------------- box state

resolve_box() {
  local ref="$1" id
  id="$(q "SELECT id FROM box WHERE id = '$ref' OR name = '$ref' ORDER BY \"createdAt\" DESC LIMIT 1")"
  [ -n "$id" ] || die "no box named or id'd '$ref' in the local database"
  echo "$id"
}

box_field() { q "SELECT \"$2\" FROM box WHERE id = '$1'"; }

# Polls the box row, which is the only signal that the transition has committed
# — and committing is precisely what opens the window this scenario needs.
wait_for_state() {
  local id="$1" want="$2" timeout="${3:-180}"
  # Separate declaration: under `set -u` a later initializer in the same `local`
  # cannot read an earlier one (bash 3.2, which is what macOS ships).
  local deadline=$((SECONDS + timeout)) seen
  while [ "$SECONDS" -lt "$deadline" ]; do
    seen="$(box_field "$id" state)"
    [ "$seen" = "$want" ] && return 0
    [ "$seen" = "error" ] && die "box $id went to error: $(box_field "$id" errorReason)"
    sleep 1
  done
  die "box $id still '$(box_field "$id" state)' after ${timeout}s, wanted '$want'"
}

open_period_summary() {
  q "SELECT coalesce(string_agg(format('cpu=%s mem=%s disk=%s since %s', cpu, mem, disk, \"startAt\"), '; '), '(none)')
     FROM box_usage_periods WHERE \"boxId\" = '$1' AND \"endAt\" IS NULL"
}

# ---------------------------------------------------------------- the crash

kill_api() {
  [ -f "$API_PID_FILE" ] || die "no API pid file at $API_PID_FILE — is the API running?"
  local pid pgid
  pid="$(cat "$API_PID_FILE")"
  kill -0 "$pid" 2>/dev/null || die "API pid $pid is not alive"
  pgid="$(ps -o pgid= -p "$pid" | tr -d ' ')"
  log "SIGKILL the API process group ($pgid) — no shutdown hooks, no draining"
  kill -9 -"$pgid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
}

restart_api() {
  log "restarting the API"
  make -C "$INFRA_LOCAL" restart COMPONENTS=api >/dev/null
  local deadline=$((SECONDS + 180))
  while [ "$SECONDS" -lt "$deadline" ]; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/api/health" || true)" = "200" ] && { log "API healthy again"; return 0; }
    sleep 2
  done
  die "API did not become healthy within 180s"
}

# Reports, then exits non-zero if anything was found, so this doubles as a cron
# check or a CI gate. The audit file carries no psql directives precisely so the
# same query can be rendered for a human and counted for a status code.
audit() {
  local findings
  log "auditing the ledger against the box table${1:+ — $1}"
  psql --pset=border=2 -f "$AUDIT_SQL"
  findings="$(psql -qtAX -f "$AUDIT_SQL" | grep -c '[^[:space:]]' || true)"
  [ "$findings" -eq 0 ]
}

# The drift is only visible while the box sits in the state it crashed into: the
# next transition overwrites the ledger with a shape that looks self-consistent
# again, leaving the mis-billed span with nothing to point at it. So report the
# box's own state alongside every audit, and treat a box that moved on as an
# inconclusive run rather than a clean one.
assert_undisturbed() {
  local id="$1" want="$2" seen
  seen="$(box_field "$id" state)"
  [ "$seen" = "$want" ] && return 0
  warn "box $id is '$seen', not the '$want' it crashed into — something moved it"
  warn "(a dashboard tab left open, or the API's watch mode reloading on a source edit)"
  warn "the drift this scenario creates is no longer observable; re-run without touching the box"
  return 1
}

# ---------------------------------------------------------------- scenarios

# from_state: the state the box must be in to start the scenario
# action:     the REST call that drives the transition
# to_state:   the state whose commit opens the window we kill in
run_scenario() {
  local name="$1" ref="$2" from_state="$3" action="$4" to_state="$5"
  local id org token lock

  id="$(resolve_box "$ref")"
  org="$(box_field "$id" organizationId)"
  [ "$(box_field "$id" state)" = "$from_state" ] ||
    die "scenario '$name' needs a box in '$from_state'; $id is '$(box_field "$id" state)'"

  token="$(ensure_api_key "$org")"
  lock="$(usage_lock_key "$id")"

  log "box $id ($(box_field "$id" name)) — open period before: $(open_period_summary "$id")"

  log "taking UsageService's lock '$lock' so its handler parks instead of writing"
  [ "$(redis SET "$lock" scenario EX 600 NX)" = "+OK" ] ||
    die "lock $lock is already held — a handler may be mid-flight; retry in a minute"

  log "POST /api/v1/boxes/$id/$action"
  curl -fsS -X POST -H "Authorization: Bearer $token" "$API_URL/api/v1/boxes/$id/$action" >/dev/null ||
    { redis DEL "$lock" >/dev/null; die "$action call failed"; }

  log "waiting for the box row to commit '$to_state' (the ledger write is parked behind the lock)"
  wait_for_state "$id" "$to_state"
  log "row committed, ledger still shows: $(open_period_summary "$id")"

  kill_api

  log "releasing the lock so the restarted API is not blocked by it"
  redis DEL "$lock" >/dev/null

  restart_api

  log "box is '$(box_field "$id" state)' / desired '$(box_field "$id" desiredState)'"
  log "open period after the restart: $(open_period_summary "$id")"
  assert_undisturbed "$id" "$to_state" || return 1
  # A finding here is the scenario succeeding, so its non-zero status is not a
  # failure of this run — only of the ledger.
  audit "immediately after the restart" || true

  # sync-states runs every 10s and is the only thing that re-drives a box, but
  # it selects boxes whose desiredState differs from their state — a box that
  # settled before the crash is invisible to it. 20s is two full ticks.
  log "waiting 20s for two sync-states ticks"
  sleep 20

  log "open period after two sync-states ticks: $(open_period_summary "$id")"
  assert_undisturbed "$id" "$to_state" || return 1
  audit "after two sync-states ticks" || true
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    audit)
      require_tools
      audit
      ;;
    key)
      require_tools
      ensure_api_key "$(q "SELECT \"organizationId\" FROM organization_user WHERE role = 'owner' ORDER BY \"createdAt\" LIMIT 1")"
      ;;
    cleanup)
      require_tools
      q "DELETE FROM api_key WHERE name = 'usage-crash-scenario'" >/dev/null
      rm -f "$KEY_FILE"
      log "scenario API key revoked"
      ;;
    lost-start)
      [ $# -eq 2 ] || die "usage: $0 lost-start <box-name-or-id>"
      require_tools
      run_scenario lost-start "$2" stopped start started
      ;;
    lost-stop)
      [ $# -eq 2 ] || die "usage: $0 lost-stop <box-name-or-id>"
      require_tools
      run_scenario lost-stop "$2" started stop stopped
      ;;
    *)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 2
      ;;
  esac
}

main "$@"
