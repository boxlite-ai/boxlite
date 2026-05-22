# Refreshing `schema-baseline.sql` from prod

`schema-baseline.sql` is a snapshot of the dev/prod RDS schema, dumped from
`boxlite-dev-databaseinstance-rkdzodee` (account 064212132677, ap-southeast-1).
Refresh it when prod migrations change.

## Prerequisites

- AWS profile with `ssm:StartSession` permission (the standard `boxlite-ro`
  profile cannot do this — you need a write-capable profile, e.g. `michaelli`)
- `session-manager-plugin` installed (`brew install --cask session-manager-plugin`)
- `pg_dump` 17.x (`brew install postgresql@17`; the binary is at
  `/opt/homebrew/opt/postgresql@17/bin/pg_dump` — `brew link --force postgresql@17`
  if you want it on PATH)
- The decrypted DB password (see Claude memory `reference_prod_pg_access.md`
  for the SST/Pulumi state decryption procedure)

## Steps

```bash
# 1. Open SSM tunnel to RDS via the runner-default EC2 (same VPC as RDS)
aws --profile <write-capable-profile> --region ap-southeast-1 ssm start-session \
  --target i-0ee6bc569d5a1e9ef \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters 'host=boxlite-dev-databaseinstance-rkdzodee.cfg46m048i6f.ap-southeast-1.rds.amazonaws.com,portNumber=5432,localPortNumber=15432' &

# Tunnel takes ~5-8s to come up; verify:
lsof -nP -iTCP:15432 -sTCP:LISTEN

# 2. Dump schema-only (no owner, no privs — strips RDS-specific roles/grants)
PGDUMP=/opt/homebrew/opt/postgresql@17/bin/pg_dump
PGHOST=127.0.0.1 PGPORT=15432 PGUSER=postgres PGDATABASE=boxlite PGPASSWORD=<decrypted> \
  $PGDUMP \
    --schema-only \
    --no-owner --no-privileges \
    --no-publications --no-subscriptions --no-comments \
    > apps/infra-local/sql/schema-baseline.sql

# 3. Append the migrations table data so RUN_MIGRATIONS=true on local API
#    sees all prod migrations as already applied (no-op on boot).
PGHOST=127.0.0.1 PGPORT=15432 PGUSER=postgres PGDATABASE=boxlite PGPASSWORD=<decrypted> \
  $PGDUMP --data-only --table=migrations --no-owner --no-privileges \
    >> apps/infra-local/sql/schema-baseline.sql

# 4. Close the tunnel
kill %1
```

## What the file contains

| Section | Lines | Purpose |
|---|---|---|
| `SET ...` session params | head | Standard pg_dump prologue |
| `CREATE EXTENSION uuid-ossp` | ~1 | Required for UUID PK generation |
| `CREATE TYPE` (enums) | several | Domain enums (api_key_permissions, sandbox_state, etc.) |
| `CREATE TABLE` | 27 | Core schema |
| `CREATE INDEX` / constraints | 76 | Performance + integrity |
| `COPY migrations` | 1 | All applied migrations (88 as of last refresh) |

## PG17-specific directives

The dump includes `\restrict`/`\unrestrict` psql directives and
`SET transaction_timeout = 0;`. **Both require PG 17+**. The infra-local
postgres image is pinned to `postgres:17-alpine` so this is fine.

If you ever need to load this into PG 16 or older, sed them out:

```bash
sed -i '' -E '/\\(restrict|unrestrict)|transaction_timeout/d' schema-baseline.sql
```

## Drift between repo migrations and prod

At last refresh the DB had **88 migrations applied** but the repo
(`apps/api/src/migrations/*-migration.ts`) only contained **79 files**.
Prod is ahead of repo by 9 migrations. Either prod manually ran some, or
some migrations were squashed out of the repo. This baseline captures the
**prod final state**, so loading it locally is the right thing to do — the
local API with `RUN_MIGRATIONS=true` will see those 88 as applied and do
nothing. If you ever want to test a NEW migration locally, add it to the
repo AND insert its row into the local `migrations` table after loading
this baseline.
