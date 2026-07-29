# Box usage-period failure injection

Answers one question: **can a box end up running with nothing billing it, or
finished with a period still open?**

Yes, in both directions, and one of them is permanent.

## Why the window exists

`BoxRepository.update()` commits the box row inside a transaction, then emits
the state event _outside_ it:

| Step                                                   | Where                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| box row committed                                      | [`box.repository.ts:106-126`](../../api/src/box/repositories/box.repository.ts)   |
| event emitted (synchronous, nobody awaits the handler) | [`box.repository.ts:128`](../../api/src/box/repositories/box.repository.ts)       |
| handler takes a Redis lock, _then_ writes the ledger   | [`usage.service.ts:51,70,118-151`](../../api/src/usage/services/usage.service.ts) |

So `update()` resolves — and the API answers the client — while the ledger write
is still in flight. There is no outbox, no retry, and no queue: the intent to
bill exists only in that process's memory. Anything that kills the process in
that window loses the write silently.

Two things make it worse:

- `@nestjs/event-emitter` wraps every `@OnEvent` listener in a try/catch whose
  `suppressErrors` defaults to `true`
  ([`event-subscribers.loader.js:106-118`](../../node_modules/@nestjs/event-emitter/dist/event-subscribers.loader.js)).
  `UsageService`'s decorators pass no options, so a handler that throws is
  downgraded to one `[Event]` log line. No crash, no alert, no retry.
- The only self-healing is `closeAndReopenUsagePeriods`, and it only looks at
  periods already older than 24h ([`usage.service.ts:162-173`](../../api/src/usage/services/usage.service.ts)).
  Nothing anywhere looks for a _missing_ period.

## Results

Measured against a real Postgres + Redis, killing a real process holding the
real `UsageModule` graph. `apps/api` is not modified by any of this.

|     | Scenario                                                                              | Outcome                                                                                  |
| --- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| S1  | box reaches `STARTED`, API `SIGKILL`ed before the ledger write                        | **divergence** — box runs, ledger empty                                                  |
| S2  | box reaches `DESTROYED`, API `SIGKILL`ed before the close                             | **divergence** — period stays open; closed only once it ages past 24h                    |
| S3  | box reaches `STOPPING`, API `SIGKILL`ed between closing compute and opening disk-only | **divergence** — stopped box's disk billed to nobody, permanently                        |
| S4  | same window, graceful `SIGTERM`                                                       | consistent — shutdown blocked 2.0s until the write landed                                |
| S5  | Redis unreachable when the event fires                                                | **divergence** — box row commits, ledger write lost as a log line, process stays healthy |
| S6  | per-box lock left by a dead process (TTL 5s)                                          | consistent — write landed 5.0s late                                                      |
| S7  | graceful `SIGTERM` with **two** handlers in flight                                    | **divergence** — drain reported empty, shutdown took 21ms, parked box never billed       |
| S8  | 3 more rounds of both crons over the S1 box                                           | **divergence persists** — nothing repairs a missing period                               |

S1/S3/S5/S7 never heal. S2 heals after up to 24h of over-billing.

A graceful `SIGTERM` is safe **only while exactly one handler is in flight**.
`main.ts:173` calls `enableShutdownHooks()` and
`UsageService.onApplicationShutdown` ([`usage.service.ts:40-46`](../../api/src/usage/services/usage.service.ts))
drains `activeJobs` first — but `@TrackJobExecution` keys that Set by _method
name_, not by invocation
([`track-job-execution.decorator.ts:20-25`](../../api/src/common/decorators/track-job-execution.decorator.ts)).
Two concurrent `handleBoxStateUpdate` calls therefore share a single entry, and
whichever finishes first deletes it out from under the other. S7 measures the
consequence: the drain returned in 21ms and the process exited with a handler
still mid-write, so that box was never billed. In S4, with a single handler in
flight, the same shutdown was still blocked 1.5s later and the period did land.

The regime, not the odds: **once two handlers overlap, the drain guarantees
nothing**, because `activeJobs` cannot tell one invocation from another. How
often a restart lands on such an overlap depends on traffic and is not something
this suite measures — S7 manufactures the overlap with a held lock.

Note also that an unreachable Redis **loses** the write rather than wedging it:
`RedisLockProvider.lock()` awaits `redis.set(...)`, which rejects on a closed
connection, so the handler throws into the suppressed catch (S5). The unbounded
`while (activeJobs.size > 0)` drain only wedges on a lock that is _held_ with a
long TTL, where `waitForLock` spins instead of failing.

These scenarios prove the window is **reachable**, not how often production hits
it. S1/S2/S4/S6/S7 hold the window open by taking the per-box Redis lock the
handler waits on, and S3 by a `BEFORE INSERT` `pg_sleep`; unaided, the window is
however long the lock plus one INSERT takes. Read the results as "this can
happen and nothing detects it", not as a frequency estimate.

## Running it

S5 and S7 — the two findings that are about a _handler_ failing rather than the
process dying — are also pinned as CI tests in
`apps/api/src/usage/usage.crash-recovery.integration.spec.ts`
("when the handler fails instead of the process" and "the graceful-shutdown
drain"), so a regression is caught without running this harness. What only this
harness can do is kill a real process and measure the drain, which is why S1–S8
stay here.

Automated — creates and drops its own `boxlite_usage_chaos` database and uses
Redis db 14, so it touches nothing live:

```bash
cd apps && node scripts/usage-period-chaos/run.mjs
```

Defaults to the Docker stack (Postgres `55432` / Redis `6379`). Override with
`CHAOS_DB_HOST/PORT/USER/PASSWORD`, `CHAOS_REDIS_HOST/PORT/DB`, `CHAOS_ADMIN_DB`.
The infra-local Postgres (`25432`) works but is a microVM and drops connections
under this load.

How the windows are opened, without touching production code:

- **Redis lock** — the handler's first act is `waitForLock(boxId)`. Holding
  `usage-period-<boxId>` parks it indefinitely, leaving exactly the
  committed-box / unwritten-ledger state.
- **`BEFORE INSERT` trigger** — a `pg_sleep` on `box_usage_periods` parks the
  handler _between_ closing the old period and opening the new one, which is
  otherwise sub-millisecond.

## Reproducing S1 against the real API

> The steps below are automated end-to-end by
> `apps/infra-local/scripts/usage-crash-scenario.sh lost-start <box>` (and
> `lost-stop` for the other direction), which also mints its own API key,
> restarts the API through `make restart COMPONENTS=api`, and audits before and
> after the `sync-states` window. Prefer it; the manual sequence is kept because
> it is what the script encodes, step for step.

```bash
# 1. the API process and a box that is currently stopped
lsof -nP -iTCP:3001 -sTCP:LISTEN -t
BOX=<boxId>

# 2. park that box's usage handler (infra-local Redis; use --port 6379 for the Docker stack)
node apps/scripts/usage-period-chaos/park-handler.mjs hold $BOX --port 26379 --ttl 600

# 3. start the box — the API commits state=started and returns; the handler blocks
curl -X POST -H "Authorization: Bearer $BOXLITE_API_KEY" \
  http://localhost:3001/api/v1/boxes/$BOX/start

# 4. confirm the box moved but the ledger did not
psql -h 127.0.0.1 -p 25432 -U boxlite -d boxlite \
  -c "select state from box where id='$BOX'" \
  -c "select count(*) from box_usage_periods where \"boxId\"='$BOX'"

# 5. hard-kill the API
kill -9 $(lsof -nP -iTCP:3001 -sTCP:LISTEN -t)

# 6. release the lock, then restart the API
#    (nx serve waits for a file change, so touch a source file to trigger it)
node apps/scripts/usage-period-chaos/park-handler.mjs release $BOX --port 26379
touch apps/api/src/main.ts

# 7. the box is running and unbilled — and stays that way
apps/infra-local/scripts/usage-crash-scenario.sh audit
```

For S2, park the handler and issue `DELETE /api/v1/boxes/$BOX` at step 3 instead;
the period stays open on a destroyed box.

## Detecting divergence in a live ledger

`apps/infra-local/scripts/usage-ledger-audit.sql` is the detector — read-only,
safe against production, run with an exit code via
`apps/infra-local/scripts/usage-crash-scenario.sh audit`. Ten finding classes
(`MISSING_OPEN`, `MISSING_OPEN_DISK`, `UNDERBILLED_COMPUTE`, `STALE_OPEN`,
`OVERBILLED_COMPUTE`, `ORPHAN_OPEN`, `WRONG_SIZE`, `MULTI_OPEN`, `OVERLAP`,
`GAP`) covering both billing directions plus the period chain.

Detection deliberately lives in one place. This directory injects faults and
measures what the ledger does; it does not carry a second detector, because the
weaker of two eventually gets trusted.

## What would actually close the gap

In rough order of cost:

1. **Run `usage-ledger-audit.sql` on a schedule.** Cheapest by far, and it turns
   silent revenue loss into an alert. It does not fix anything.
2. **`suppressErrors: false`** on `UsageService`'s two `@OnEvent` decorators, so
   a failed ledger write is at least loud instead of one log line among many.
3. **Make `activeJobs` count invocations, not method names** — a counter, or a
   Set of unique ids. One line, and it turns every S7 back into an S4, which is
   the difference between a rolling restart being safe and being safe only when
   the fleet happens to be idle.
4. **Extend the roll-over into a reconciler.** It already walks open periods
   every minute with the box row in hand; the missing half is the other
   direction — billable boxes with no open period — plus dropping the 24h floor
   for boxes that are already terminal.
5. **Write the ledger in the same transaction as the box row**, or via an
   outbox drained by the existing cron. This is the only option that actually
   removes the window rather than shrinking it.
