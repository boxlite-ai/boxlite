#!/usr/bin/env bash
# Load the production schema baseline into the local boxlite-local-postgres box.
#
# When to run:
#   - First time after `make up` on a fresh data dir
#   - After `make wipe` (which clears the data dir)
#   - When schema-baseline.sql is refreshed from prod
#
# NOT idempotent: postgres has no `CREATE TYPE IF NOT EXISTS`, so re-running
# on a populated DB will fail on the first enum. The script refuses to run
# when the public schema already has tables; wipe + re-up first.
#
# Refresh the baseline (rare — only when prod schema changes):
#   See `apps/infra-local/sql/REFRESH.md`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="${SCRIPT_DIR}/../sql/schema-baseline.sql"

if [[ ! -f "${SQL_FILE}" ]]; then
  echo "ERR: ${SQL_FILE} not found." >&2
  exit 1
fi

# Defaults match boxlite_local/config.py InfraConfig() — override via env if needed.
HOST="${BOXLITE_PG_HOST:-127.0.0.1}"
PORT="${BOXLITE_PG_HOST_PORT:-25432}"
USER="${BOXLITE_PG_USER:-boxlite}"
DB="${BOXLITE_PG_DB:-boxlite}"
PASSWORD="${BOXLITE_PG_PASSWORD:-boxlite}"

echo "Loading ${SQL_FILE} into ${USER}@${HOST}:${PORT}/${DB}..."

# Quick reachability probe so we fail fast with a clear message.
if ! PGPASSWORD="${PASSWORD}" psql -h "${HOST}" -p "${PORT}" -U "${USER}" -d "${DB}" \
       -c 'SELECT 1' >/dev/null 2>&1; then
  echo "ERR: cannot reach postgres at ${HOST}:${PORT} as user ${USER}." >&2
  echo "     Did you run 'make up' first?" >&2
  exit 2
fi

# The baseline is not idempotent (CREATE TYPE has no IF NOT EXISTS), so a
# second full load would error mid-way. But "schema already present" is the
# common, healthy state after a machine reboot — the postgres box is gone
# yet ~/.boxlite-local/data/pg/ (a persistent volume) still holds the full
# schema. In that case `load-schema` should be a no-op, not a hard failure,
# so `make up-with-schema` / `make stack-up` keep working across reboots.
#
# Distinguish the two cases:
#   - COMPLETE prior load (tables + migrations recorded) → skip, exit 0.
#   - PARTIAL half-applied baseline (tables but no migrations) → refuse.
existing_tables=$(PGPASSWORD="${PASSWORD}" psql -h "${HOST}" -p "${PORT}" -U "${USER}" -d "${DB}" \
  -tA -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public';")
if [[ "${existing_tables:-0}" -gt 0 ]]; then
  # `migrations` is created by the baseline itself; a populated migrations
  # table means the prior load ran to completion.
  migrations_recorded=$(PGPASSWORD="${PASSWORD}" psql -h "${HOST}" -p "${PORT}" -U "${USER}" -d "${DB}" \
    -tA -c "SELECT count(*) FROM migrations;" 2>/dev/null || echo 0)
  if [[ "${migrations_recorded:-0}" -gt 0 ]]; then
    echo "Schema already loaded (${existing_tables} tables, ${migrations_recorded} migrations recorded) — skipping."
    echo "(To force a clean reload: 'make wipe && make up && make load-schema'.)"
    exit 0
  fi
  echo "ERR: public schema has ${existing_tables} table(s) but the migrations table is empty/missing." >&2
  echo "     This looks like a half-applied baseline. Run 'make wipe && make up' first," >&2
  echo "     then re-run 'make load-schema'." >&2
  exit 3
fi

PGPASSWORD="${PASSWORD}" psql \
  -h "${HOST}" -p "${PORT}" -U "${USER}" -d "${DB}" \
  -v ON_ERROR_STOP=1 \
  -f "${SQL_FILE}"

echo
echo "Schema loaded. Verifying..."
PGPASSWORD="${PASSWORD}" psql -h "${HOST}" -p "${PORT}" -U "${USER}" -d "${DB}" -c "
  SELECT
    (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') AS tables,
    (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public') AS indexes,
    (SELECT count(*) FROM migrations) AS migrations_recorded;
"
