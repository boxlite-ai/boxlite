# Usage-ledger drift scenarios

Tools for answering one question: **can a box be running with no usage period
open, or stopped with one still open?**

Yes, both. This directory reproduces it, and audits for it.

## Why it happens

`box_usage_periods` has exactly one writer, `UsageService`
(`apps/api/src/usage/services/usage.service.ts`), and it is driven entirely by
in-process events:

```
BoxRepository.update()
  └─ transaction { UPDATE box … }            COMMIT   ← box row is now authoritative
  └─ emitUpdateEvents()                               ← EventEmitter2, not awaited
       └─ UsageService.handleBoxStateUpdate()         ← the only ledger write
            └─ waitForLock(`usage-period-<boxId>`)    ← first await; can park here
            └─ closeUsagePeriod() / createUsagePeriod()
```

The commit and the ledger write are not atomic, and the event between them is
neither persisted nor retried. Anything that ends the process in that window —
SIGKILL, a crash, an OOM, or a graceful restart whose 5s grace expires while a
handler is parked on its lock — drops the pending write with nothing recording
that it was owed.

What happens next is asymmetric:

| Lost transition | Ledger says | Effect | Repaired by |
|---|---|---|---|
| → STARTED | nothing open, or the previous disk-only period still open | box runs **unbilled** | neither cron; only the box's next real transition |
| → STOPPING / STOPPED | compute period still open | box **billed compute while stopped** | `closeAndReopenUsagePeriods` once the period is ≥24h old, or the next real transition, whichever comes first |
| → DESTROYED | period still open on a deleted box | box **billed after deletion** | the 24h roll-over — a destroyed box has no next transition |
| → STARTED after a resize | old size still open | billed at the **old size** | neither cron; the roll-over copies the stale size forward via `fromUsagePeriod`, so it outlives every tick |

No repair is retroactive. Every path above fixes what happens *from now on*; the
span that was mis-billed while the drift stood is never restated.

Nothing self-heals quickly because the two crons in `UsageService` both start
from `box_usage_periods`: the roll-over iterates periods that already exist (so
a box with no row is invisible to it), and the archive sweep only moves closed
rows. `BoxManager.syncStates` — the one job that re-drives a box — selects
`desiredState <> state`, so a box that settled *before* the crash is skipped.
Re-issuing `start` on it emits nothing either, because `emitUpdateEvents` fires
only on a change.

## Where each tool lives

| Job | Tool |
|---|---|
| Catch a regression in CI | `apps/api/src/usage/usage.crash-recovery.integration.spec.ts` |
| Measure what a real process kill does (S1–S8) | `apps/scripts/usage-period-chaos/run.mjs` |
| Inject the fault into the running local stack, on a real box | `usage-crash-scenario.sh` (here) |
| Find drift in any live ledger | `usage-ledger-audit.sql` (here) |

The chaos harness in `apps/scripts/usage-period-chaos/` came first and covers
ground this directory does not: it kills a real process holding the real
`UsageModule` graph and times the shutdown drain. Its two handler-level findings
— an unreachable Redis losing the write to a log line, and the graceful drain
returning early — are pinned as CI tests in the spec below. Detection lives here
and only here: `usage-ledger-audit.sql` is the one detector, so there is nothing
to drift against.

## The two tiers

### 1. Deterministic — `usage.crash-recovery.integration.spec.ts`

Lives with the code it tests (`apps/api/src/usage/`). Needs a Postgres and a
Redis; it creates and drops its own database, so it is safe next to a running
stack.

Point it at the **Docker** Postgres and Redis, not infra-local's:

```bash
cd apps
DB_HOST=127.0.0.1 DB_PORT=55432 DB_USERNAME=postgres DB_PASSWORD=postgres \
DB_DATABASE=postgres REDIS_HOST=127.0.0.1 REDIS_PORT=6379 \
npx nx test api --testPathPatterns='usage.crash-recovery' --runInBand
```

infra-local's Postgres (`25432`) is an L1 microVM with `max_files_per_process`
1000, and `CREATE DATABASE` on it currently PANICs with `could not close file …:
No file descriptors available` — which is the first thing this spec's `beforeAll`
does. The server recovers on its own in about a second and loses nothing, but the
run dies. `--runInBand` is needed for the same budget: the full parallel suite
exhausts it too.

`DB_DATABASE` is only the database the spec connects to in order to create its
own (`<DB_DATABASE>_box_usage_crash`), so any existing database works — but never
name one holding real usage: the sibling `usage.service.integration.spec.ts`
drops the ledger tables outright, and its own guard will refuse to run if they
hold rows.

18 scenarios: the window itself (a committed STARTED that is provably unbilled
while its handler is parked), then a lost START / STOP / DESTROY / resize, each
followed through an API restart, the roll-over cron, and the next real
transition.

Its sibling `usage.lifecycle.integration.spec.ts` covers the healthy path.

### 2. End-to-end — `usage-crash-scenario.sh`

Drives a real box on the running stack and really SIGKILLs the API.

```bash
cd apps/infra-local
./scripts/usage-crash-scenario.sh lost-start <box>   # box must be stopped
./scripts/usage-crash-scenario.sh lost-stop  <box>   # box must be started
./scripts/usage-crash-scenario.sh audit              # drift report only
./scripts/usage-crash-scenario.sh cleanup            # revoke the scenario API key
```

Each run: takes `UsageService`'s own per-box Redis lock so the handler parks
instead of writing → calls `POST /api/v1/boxes/<id>/{start,stop}` → waits for the
box row to commit the new state → `kill -9` on the API process group → releases
the lock → `make restart COMPONENTS=api` → audits immediately, then again after
two `sync-states` ticks.

The lock is what makes this deterministic, and it is worth being precise about
what that does and does not show. Unaided, the window is a Redis round-trip
(`waitForLock`) plus one to three Postgres queries — the `SELECT` for the open
period, its `UPDATE`, and the `INSERT` — so the script *holds it open* rather
than waiting to catch a spontaneous race. That proves the window is reachable and
that nothing repairs what falls into it. It says nothing about how often
production lands there.

It mints itself an API key directly in the database (cached in
`.apps-local/usage-crash-scenario.key`) and kills a process by pid file — local
stack only, never a shared environment.

**Leave the box alone while it runs.** The drift is only observable while the
box sits in the state it crashed into; the next transition overwrites the ledger
with something self-consistent and the mis-billed span becomes invisible. A
dashboard tab left open, or the API's watch mode reloading because a file under
`apps/api/src` changed, is enough to mask it. The script warns and stops if the
box moved.

To repair a box the scenario left drifted, stop and start it for real — the next
transition rewrites its open period correctly.

## The auditor — `usage-ledger-audit.sql`

Read-only, no infra-local assumptions; point it at any environment.

```bash
psql "postgresql://boxlite:boxlite@127.0.0.1:25432/boxlite" -f scripts/usage-ledger-audit.sql
```

One row per disagreement between `box` and the ledger, worst first:

| Finding | Meaning |
|---|---|
| `MISSING_OPEN` | started box with no open period — unbilled |
| `MISSING_OPEN_DISK` | stopped box with no open period — disk unbilled |
| `UNDERBILLED_COMPUTE` | started box whose open period bills `cpu=0` |
| `OVERBILLED_COMPUTE` | stopped box whose open period still bills compute |
| `STALE_OPEN` | destroyed / errored box still billing |
| `ORPHAN_OPEN` | open period whose box row is gone |
| `WRONG_SIZE` | open period bills a size the box no longer has |
| `MULTI_OPEN` | more than one period open for a box |
| `OVERLAP` / `GAP` | the period chain double-bills or skips time |

It is a **point-in-time** check. It catches a box that is *currently* drifted; it
cannot see a span that was mis-billed and then papered over by a later
transition. That blind spot is the reason the lost-START case is the serious one:
by the time anyone looks, the evidence is gone.
