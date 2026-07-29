# Box usage-period ledger: healthy-path verification and crash-path failure analysis

**Date:** 2026-07-29
**Status:** Verified; no fix implemented
**Scope:** `apps/api/src/usage/` (`UsageService` + `box_usage_periods` / `box_usage_periods_archive`)

---

## Summary

On the healthy path the ledger is correct: 29 lifecycle scenarios pass, and all 10 mutations of the production code are caught by them.

On the crash path the ledger drifts away from reality, and **most of that drift never heals**. Six of eight failure-injection scenarios end with a ledger that disagrees with the box table:

- **A box is running but nothing is billing it** — permanent revenue loss; no sweep detects or repairs it.
- **A box is finished but its period is still open** — continued over-billing, closed at best by the daily roll-over up to 24h later.

The root cause is one unprotected write window: the box row commits in a transaction that does not include the ledger write, and between them sits neither an outbox, nor a retry, nor a queue.

---

## 1. How the ledger is meant to work

A box bills against at most one open period (`endAt IS NULL`) at a time, enforced by the Postgres partial unique index `box_usage_periods_one_open_period_per_box_idx`.

The billing semantics are two event handlers and two cron jobs in `UsageService`:

| Trigger                                           | Behaviour                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STARTED`                                         | Close the previous period, open a new one at the box's cpu/gpu/mem/disk                                                                          |
| `STOPPING`                                        | Close the compute period, open a **disk-only** one (cpu/gpu/mem = 0)                                                                             |
| `STOPPED` (having skipped `STOPPING`)             | Safeguard: if a period is still open with cpu ≠ 0, close it and reopen disk-only                                                                 |
| `desiredState → DESTROYED`                        | Close immediately — billing stops when **deletion is requested**, not when the box is actually gone                                              |
| `ERROR` / `ARCHIVED` / `DESTROYING` / `DESTROYED` | Close the period                                                                                                                                 |
| `close-and-reopen-usage-periods` (every minute)   | Roll a period open longer than 24h; zero the compute if the box is already `STOPPED`; close without reopening if the box is destroyed or missing |
| `archive-usage-periods` (every minute)            | Move closed periods to the archive table                                                                                                         |

One asymmetry is deliberate and needs a pricing decision before anyone "fixes" it (`usage.service.ts:79-83` says so in a comment): **billing** stops charging compute the moment a stop is requested, while **quota** keeps counting `STOPPING` as compute, because the runner has not released cpu/memory yet.

---

## 2. Healthy-path verification

`apps/api/src/usage/usage.lifecycle.integration.spec.ts`, 29 scenarios.

How it differs from the two existing usage.service specs: the unit spec (`usage.service.spec.ts`) builds event objects itself and calls the handlers directly; the integration spec (`usage.service.integration.spec.ts`) stubs the box repository and calls the crons directly. Both verify function bodies. In this suite **every state transition goes through the production `BoxRepository.update()`**, whose own emit is the only thing that reaches the handlers, against the real `UsageModule` on a real Postgres and Redis. That closes the gap neither existing spec covers: whether a box changing state produces those events at all.

Coverage:

- **Lifecycle (15)** — start opens a period; a box that never starts bills nothing; stopping switches to disk-only; `STOPPING → STOPPED` adds no redundant row; the safeguard for `STOPPED` reached without `STOPPING`; restart resumes compute billing; **a resize bills at the new size**; a delete request stops billing; `DESTROYING → DESTROYED` neither reopens nor re-closes; a running box that errors gets closed; intermediate states (`STARTING`/`RESTORING`/`RESIZING`) leave the ledger alone; two boxes stay independent; a full lifecycle tiles end-to-end with no overlap and no gap.
- **Daily roll-over (9)** — a running box is carried into a fresh period starting exactly where the old one ended; a stopped box has its compute zeroed; a stopping box keeps its disk; a destroyed box, or one whose row is gone, is closed without reopening; periods younger than a day are untouched; warm-pool periods are untouched; exactly one open period remains; a single run is capped at 100.
- **Archive (3)** — closed periods move across with their billed fields intact; the open one stays; a second sweep is a no-op.
- **Concurrency (2)** — a stop racing the roll-over still leaves one open period; the database refuses a second open period for the same box.

**Do the tests have teeth?** Ten separate behaviour-breaking edits were applied to the production code one at a time, re-running the suite each time and restoring afterwards: drop the `STOPPING` branch; drop the `STOPPED` safeguard; move billing's stop back to `DESTROYED`; skip zeroing compute on roll-over; start the reopened period at `now()`; drop the warm-pool filter; lift the 100-row cap; reopen for a box that is gone; archive the open period too; delete the unique index. **All 10 were caught.**

One mutation initially survived, which showed that the "zeroes compute for a stopped box" test was not exercising the branch it named — by the time the roll-over ran, its period was already disk-only. Rewriting it to use a raw update (which emits nothing) to produce a stopped box still carrying compute made the mutation fail the suite. That state is exactly what a crash leaves behind in the data.

### Incidental observations

- **The `ARCHIVED` branch is currently unreachable** — nothing in `apps/api/src` ever assigns `ARCHIVING`/`ARCHIVED`, so only the unit spec covers it.
- **A box stuck in `STOPPING` is re-billed compute by the roll-over** — the roll-over zeroes compute only when the box is `STOPPED`, not `STOPPING`. A box wedged in `STOPPING` (a lost runner, say) whose open period still carries compute is **re-opened at full compute every day**. That contradicts the policy stated at `usage.service.ts:79-83`, and it is the same bug class #1083 hardened for `STOPPED`.
- **One update that moves both `state` and `desiredState` serialises for ~500ms** — the two handlers contend on the same per-box Redis lock, and `waitForLock` polls on a fixed 500ms sleep (`usage.service.ts:257-261`). Latency only; correctness is unaffected.

---

## 3. The crash path: an unprotected write window

### 3.1 Where the window is

| Step                                                                           | Location                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Box row commits inside a transaction                                           | `apps/api/src/box/repositories/box.repository.ts:106-126`    |
| Event emitted **outside** it (synchronous emit, but nobody awaits the handler) | `box.repository.ts:128`                                      |
| Handler takes a Redis lock, **then** writes the ledger                         | `apps/api/src/usage/services/usage.service.ts:51,70,118-151` |

So `update()` resolves — and the API answers the client — while the ledger write is still in flight. No outbox, no retry, no queue: the intent to bill exists only in that process's memory. Anything that kills the process inside that window loses the write silently.

Two things make the consequences worse:

- **Failure is invisible.** `@nestjs/event-emitter@3.1.0` wraps every `@OnEvent` listener in a try/catch whose `suppressErrors` defaults to `true` (`apps/node_modules/@nestjs/event-emitter/dist/event-subscribers.loader.js:106-118`). `UsageService`'s decorators pass no options, so a handler that throws is downgraded to a single `[Event]` log line: no crash, no alert, no retry.
- **The only self-healing looks at periods that already exist.** `closeAndReopenUsagePeriods` selects periods whose `startAt` is older than 24 hours (`usage.service.ts:162-173`). Nothing anywhere looks for a period that is **missing**.

### 3.2 Failure-injection results

A real `SIGKILL` of a real process holding the same `UsageModule` / `BoxRepository` / `EventEmitter` graph the API holds, on a real Postgres and Redis. `apps/api` is not modified by any of it.

|     | Scenario                                                                        | Outcome                                                                           |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| S1  | Box reaches `STARTED`, `SIGKILL` before the ledger write                        | **drift** — box runs, ledger empty, **permanent**                                 |
| S2  | Box reaches `DESTROYED`, `SIGKILL` before the close                             | **drift** — period stays open until it ages past 24h                              |
| S3  | Box reaches `STOPPING`, `SIGKILL` between closing compute and opening disk-only | **drift** — the stopped box's disk is billed to nobody, **permanent**             |
| S4  | Same window, graceful `SIGTERM` (one handler in flight)                         | consistent — shutdown blocks until the write lands                                |
| S5  | Redis unreachable when the event fires                                          | **drift** — the box row commits, the ledger write is lost as a log line           |
| S6  | Per-box lock left behind by a dead process (TTL 5s)                             | consistent — the write lands ~5.0s late                                           |
| S7  | Graceful `SIGTERM` with **two** handlers in flight                              | **drift** — the drain reports empty, exit in 21ms, the parked box is never billed |
| S8  | Three more rounds of both crons over the S1 box                                 | **drift persists** — nothing reopens a missing period                             |

S5 and S7 are the two findings about a _handler_ failing rather than the process dying, so they do not need a process kill to reproduce. Both are pinned deterministically in `apps/api/src/usage/usage.crash-recovery.integration.spec.ts`, alongside the four lost-transition shapes (START / STOP / DESTROY / resize) followed through an API restart, the roll-over, and the box's next real transition — 18 scenarios that run in CI without this harness.

**These scenarios prove the window is reachable, not how often production lands in it.** S1/S2/S4/S6/S7 hold the window open by taking the per-box Redis lock the handler waits on; S3 uses a `BEFORE INSERT pg_sleep` trigger on `box_usage_periods`. Unaided, the window is as wide as one lock acquisition plus one INSERT. Read the results as "this happens and nothing notices", not as a frequency estimate.

### 3.3 A graceful restart is not the safe path it looks like

`main.ts:173` does call `app.enableShutdownHooks()`, and `UsageService.onApplicationShutdown` (`usage.service.ts:40-46`) does drain `activeJobs` first. But `@TrackJobExecution` keys that Set by **method name**, not by invocation (`apps/api/src/common/decorators/track-job-execution.decorator.ts:20-25`):

```ts
this.activeJobs.add(propertyKey) // ... finally: this.activeJobs.delete(propertyKey)
```

Two concurrent `handleBoxStateUpdate` calls therefore share a single entry, and whichever finishes first deletes it out from under the other. S7 measures the consequence: the drain returned in 21ms and the process exited with a handler still mid-write, so that box was never billed. In S4, with a single handler in flight, the same shutdown was still blocked 1.5s later and the period did land.

**The regime, not the odds: once two handlers overlap, the drain guarantees nothing**, because `activeJobs` cannot tell one invocation from another. How often a restart lands on such an overlap depends on traffic and was not measured — S7 manufactures the overlap with a held lock.

Note also that an unreachable Redis **loses** the write rather than wedging it: `RedisLockProvider.lock()` awaits `redis.set(...)`, which rejects on a closed connection, so the handler throws into the suppressed catch (measured in S5). The unbounded `while (activeJobs.size > 0)` drain only wedges on a lock that is _held_ with a long TTL, where `waitForLock` spins instead of failing.

> **Staleness note.** This section assumes `track-job-execution.decorator.ts` still keys by method name. If recommendation #3 in section 5 (key by invocation) lands, this section's conclusion inverts — S7 becomes "consistent", and the assertion pinning the early drain in `usage.crash-recovery.integration.spec.ts` turns red by design. Update this section when you touch that decorator.

---

## 4. Scripts and procedures

The tooling lives in two places, split by what it attacks:

| Directory                          | Role                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/infra-local/scripts/`        | End-to-end injection against the **real API** (`usage-crash-scenario.sh`) and live ledger auditing (`usage-ledger-audit.sql`) |
| `apps/scripts/usage-period-chaos/` | Windows the real API cannot reach, on a **throwaway database** (`run.mjs` + `worker.ts`); see that directory's `README.md`    |

They are complementary. The first kills the live process, which covers the commit-then-crash shape of S1/S2. The second can hold open S3 (between close and reopen), S5 (Redis unreachable), S6 (stale lock), S7 (concurrent drain) and S8 (reconciliation coverage) — each of which needs either a fault injected inside the process or a database it is free to dirty.

### 4.1 Run the whole injection suite

```bash
cd apps && node scripts/usage-period-chaos/run.mjs
```

About 47 seconds. Creates and drops its own `boxlite_usage_chaos` database and uses Redis db 14, so it **touches nothing live**. Defaults to the Docker stack (Postgres `55432` / Redis `6379`); override with `CHAOS_DB_HOST/PORT/USER/PASSWORD`, `CHAOS_REDIS_HOST/PORT/DB`, `CHAOS_ADMIN_DB`. The infra-local Postgres (`25432`) works too, but it runs in a microVM and drops connections under this load.

### 4.2 Reproduce S1 / S2 against the real API

```bash
# box is up but nothing started billing it
apps/infra-local/scripts/usage-crash-scenario.sh lost-start <box-name-or-id>

# box stopped but its period never closed
apps/infra-local/scripts/usage-crash-scenario.sh lost-stop <box-name-or-id>
```

The script runs the whole sequence itself: take the `usage-period-<boxId>` lock so the handler parks → issue the real REST call → wait for the box row to commit the target state → `kill -9` the real API → **release the lock before restarting** (otherwise the restarted API blocks on it) → audit once after the restart and again after two full `sync-states` ticks. It also mints the API key it needs (`usage-crash-scenario.sh key` / `cleanup`).

To drive the sequence by hand, `apps/scripts/usage-period-chaos/park-handler.mjs hold|release <boxId>` takes and releases that lock on its own.

### 4.3 Auditing a live ledger

`apps/infra-local/scripts/usage-ledger-audit.sql` is the reconciliation the API does not have: pure SQL, read-only, safe against production. Run it with an exit code via `usage-crash-scenario.sh audit`, which makes it usable as a cron check or a CI gate.

Ten finding classes; severity comes from the first column of each `SELECT` in the SQL (1 → `HIGH`, 2 → `MED`). The table below restates the SQL and can drift from it, so a check guards it — run this after changing `usage-ledger-audit.sql`:

```bash
node apps/scripts/usage-period-chaos/check-audit-classes.mjs
```

| Severity | Group         | Finding               | Fires when                                                                                                       |
| -------- | ------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| HIGH     | under-billing | `MISSING_OPEN`        | Box is `started` (and not pending deletion) with no open period                                                  |
| HIGH     | under-billing | `MISSING_OPEN_DISK`   | Box is `stopping`/`stopped` with no open period — its disk is billed to nobody                                   |
| HIGH     | under-billing | `UNDERBILLED_COMPUTE` | Box is `started` but its open period bills `cpu=0`                                                               |
| HIGH     | over-billing  | `STALE_OPEN`          | Box reached `error`/`archived`/`destroying`/`destroyed`, or `desiredState=destroyed`, and a period is still open |
| HIGH     | over-billing  | `OVERBILLED_COMPUTE`  | Box is `stopping`/`stopped` but its open period still bills `cpu>0`                                              |
| HIGH     | over-billing  | `ORPHAN_OPEN`         | A period is open but the box row is gone                                                                         |
| HIGH     | structural    | `MULTI_OPEN`          | One box has several periods open at once — active double billing, hence graded with the billing classes          |
| MED      | wrong amount  | `WRONG_SIZE`          | Box is `started` with compute billing, but the period's cpu or disk disagrees with the box — a lost resize       |
| MED      | structural    | `OVERLAP`             | Two adjacent periods in the chain overlap (double billing)                                                       |
| MED      | structural    | `GAP`                 | Two adjacent periods leave more than 2 seconds unbilled                                                          |

Two points worth calling out:

- `OVERBILLED_COMPUTE` covers the section 2 observation about a box stuck in `STOPPING` being re-billed compute by the roll-over. If that box has also been marked for deletion it falls to `STALE_OPEN` instead, so there is no hole between them.
- `WRONG_SIZE` compares cpu and disk only — **not mem** (`usage-ledger-audit.sql:121-125`). A memory-only resize whose ledger write was lost is invisible to this audit.

### 4.4 Measured against the local environment

- **infra-local (25432)** — one HIGH `MISSING_OPEN_DISK`: `smoke0000001`, stopped with no open period, disk unbilled. It is **not** a crash artifact: `authToken='tok-smoke-1'` (not the shape of a `nanoid(32)`), `createdAt` exactly equal to `updatedAt`, and no `box_last_activity` row — which `BoxRepository.insert()` always writes. So it was inserted directly with SQL.
- **Docker stack (55432)** — all ten classes clean (0 rows).

In other words the local environment holds no genuine ledger drift today; that one hit shows the audit also catches hand-seeded rows.

---

## 5. Recommendations

Cheapest first:

1. **Put `usage-ledger-audit.sql` on a schedule.** By far the cheapest, and it converts silent revenue loss into an alert. It fixes nothing.
2. **Set `suppressErrors: false`** on `UsageService`'s two `@OnEvent` decorators, so a failed ledger write is at least loud rather than one log line among many.
3. **Make `activeJobs` track invocations rather than method names** (a counter, or a set of unique ids). A one-line change that turns every S7 back into an S4 — the difference between a rolling restart being safe and being safe only when the fleet happens to be idle. S7 is already the reproducer.
4. **Grow the roll-over into a real reconciler.** It already walks open periods every minute with the box row in hand; what is missing is the other direction — billable boxes with no open period — plus dropping the 24h floor for boxes already in a terminal state.
5. **Write the ledger in the box row's transaction, or via an outbox drained by the existing cron.** The only option that removes the window rather than narrowing it.

The `STOPPING` roll-over problem from the end of section 2 lives in the same code as item 4 and is worth fixing in the same pass.

---

## Appendix: related files

| File                                                            | Role                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/api/src/usage/usage.lifecycle.integration.spec.ts`        | 29 healthy-path scenarios                                                                         |
| `apps/api/src/usage/usage.crash-recovery.integration.spec.ts`   | 18 crash-path scenarios: the lost-transition shapes, plus S5 and S7 pinned deterministically      |
| `apps/api/src/usage/services/usage.service.integration.spec.ts` | Existing cron + index-invariant specs                                                             |
| `apps/api/src/usage/services/usage.service.spec.ts`             | Existing handler unit tests                                                                       |
| `apps/scripts/usage-period-chaos/run.mjs`                       | 8 failure-injection scenarios (throwaway database)                                                |
| `apps/scripts/usage-period-chaos/worker.ts`                     | The killable real Nest process carrying the real module graph                                     |
| `apps/scripts/usage-period-chaos/park-handler.mjs`              | Take / release the per-box usage lock                                                             |
| `apps/scripts/usage-period-chaos/check-audit-classes.mjs`       | Guards section 4.3's table against the SQL it restates                                            |
| `apps/infra-local/scripts/usage-crash-scenario.sh`              | End-to-end injection against the real API (`lost-start` / `lost-stop`) plus the audit entry point |
| `apps/infra-local/scripts/usage-ledger-audit.sql`               | Live ledger reconciliation (ten finding classes)                                                  |
