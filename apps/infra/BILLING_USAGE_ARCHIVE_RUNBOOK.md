# Billing Usage Archive Rollout

This change replaces the Redis-coordinated usage archive job with a PostgreSQL
`FOR UPDATE SKIP LOCKED` move. Archive IDs now reuse the active usage-period ID,
which makes archive, rating, and wallet settlement retries converge on one identity.

## Safety boundary

Do not roll this image directly while cron jobs remain enabled. An old API task can
still generate a random archive ID after a new task has moved the same source row,
which would make both archives independently billable.

This release deliberately has no usage-table schema migration. The partial claim
index was omitted because the normal TypeORM migration path is transactional and a
plain `CREATE INDEX` can block writes. Add an index later only as a separately
reviewed `CREATE INDEX CONCURRENTLY` operation if production query timing requires it.

## Required two-phase deployment

1. Set `DISABLE_CRON_JOBS=true` for the target stage and deploy the new API image.
2. Wait until the service is stable and every old API task revision has stopped.
   New tasks serve requests but run no cron jobs; old tasks may continue the legacy
   archive job only until they drain.
3. Confirm no old task revision remains. Do not use elapsed Redis-lock TTL as proof.
4. Set `DISABLE_CRON_JOBS=false` and deploy the same API image again.
5. Verify the closed-period backlog drains and no archive invariant conflict is logged.

The pause also stops rating and settlement sweeps. This delays billing but does not
lose usage: closed periods remain in PostgreSQL and are processed after phase two.

## Verification

Run the scoped checks before deployment:

```bash
make test:apps:billing-archive
make test:apps:billing-archive-db
make build:apps:api
```

Monitor the source backlog after enabling cron jobs:

```sql
SELECT count(*) AS closed_period_backlog
FROM box_usage_period
WHERE "endAt" IS NOT NULL;
```

The count should return to zero. Treat `Usage archive invariant conflict` as a stop
signal: pause cron jobs, then locate source/archive identity conflicts with:

```sql
SELECT active.id
FROM box_usage_period AS active
JOIN box_usage_period_archive AS archive ON archive.id = active.id
WHERE active."endAt" IS NOT NULL;
```

Do not manually create another archive or wallet transaction.

## Rollback

Set `DISABLE_CRON_JOBS=true`, wait for all new archive jobs to finish, roll back every
API task to one revision, and only then re-enable cron jobs. Never run old and new
archive implementations together during rollback.
