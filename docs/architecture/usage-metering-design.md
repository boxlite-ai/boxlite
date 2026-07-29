# Usage Metering and Quota Design

## Scope

Two subsystems share one event stream and are otherwise independent:

- **Metering** records what actually ran, as immutable time spans, for billing. It never rejects anything.
- **Quota** decides what may run next, from a live view of current consumption. It keeps no history.

Both are implemented by the cloud control plane. The embedded local runtime has no organization model and applies neither.

The user-facing view of both is [Organization Limits and Usage](../guides/organization-limits.md).

## Shared Event Stream

`BoxRepository.emitUpdateEvents` compares a box against its previous row after every update and emits one event per changed field. Metering and quota each subscribe independently:

```text
BoxRepository.update
  └─ emitUpdateEvents(updated, previous)
       ├─ box.state.updated ─────────┬─ UsageService            (open / close periods)
       │                             └─ OrganizationUsageService (realize reservations)
       └─ box.desired-state.updated ─── UsageService            (close on DESTROYED)
```

Neither subsystem calls the other. A box that never changes state is invisible to both, which is why the create path reserves quota explicitly rather than waiting for an event.

## Metering

### Data model

A usage period is a box's resource shape held over a time span. `endAt IS NULL` means the period is still open.

```text
box_usage_periods           open + recently closed periods (hot, small)
box_usage_periods_archive   closed periods only (cold, grows forever)
```

Both carry `boxId`, `organizationId`, `startAt`, `endAt`, `cpu`, `gpu`, `gpu_type`, `mem`, `disk`, `region`, `boxClass`, `regionType`. `organizationId` is denormalized onto the period so billing queries never join `box` — a box may be reassigned or deleted while its history must not move.

**Invariant: at most one open period per box.** Enforced in the database by a unique partial index on `("boxId") WHERE "endAt" IS NULL`, not by application logic, so a lost lock or a concurrent writer fails loudly instead of double-billing.

### Transitions

| Event | Action |
|---|---|
| `STARTED` | Close the open period, open one charging cpu / gpu / memory / disk |
| `STOPPING` | Close, open a disk-only period |
| `STOPPED` | Safeguard: if an open period still charges cpu, close and reopen disk-only |
| `ERROR`, `ARCHIVED`, `DESTROYING`, `DESTROYED` | Close |
| desired state `DESTROYED` | Close |

The `STOPPED` case exists because `STOPPING` can be skipped. It is conditional on the open period actually charging cpu, so a normal `STOPPING → STOPPED` sequence does not produce a second disk-only period.

Each handler holds `usage-period-{boxId}` (60 s) for the whole close-then-open sequence, so two events for one box cannot interleave.

### Background jobs

| Job | Cadence | Bound | Purpose |
|---|---|---|---|
| `close-and-reopen-usage-periods` | 1 min | 100 periods | Close periods open longer than 24 h and reopen an identical one |
| `archive-usage-periods` | 5 s | 5000 periods | Move closed periods to the archive table in one transaction |

Reopening bounds every period to roughly a day, so a long-lived box produces a steady stream of closed periods instead of one span that only settles when the box dies. The job re-reads the box first and only reopens if it is still in a state that consumes something, and downgrades the new period to disk-only when the box is stopped.

Archiving keeps the table the open-period index lives on small; the archive table is append-only and never read by this service.

Both jobs take a global Redis lock, so only one replica runs each, and both are idempotent — an interrupted run simply repeats.

### Region type

`regionType` is copied onto each period at creation from a TypeORM query-result cache keyed `region-type-{regionId}` with a 1 hour TTL. This requires `cache` to be enabled on the datasource. If it is not, the lookup throws, the surrounding `try/catch` falls back to `shared`, and **every period is silently billed as a shared region** — a config change with no visible failure.

## Quota

Ceilings live in `organization_quota`, one row per organization; a missing row means the built-in defaults, never "no access". Limits are read fresh on every check, so an operator's change takes effect on the next create.

### Current and pending

Current usage is a SQL sum over the organization's boxes, cached in Redis across five keys:

```text
quota:current:{orgId}:{cpu|memory|disk|gpu|count}     TTL 60 s
quota:pending:{orgId}:{cpu|memory|disk|gpu|count}     TTL 60 s
quota:current:{orgId}:populated-at                    staleness marker
```

All ten keys are read in a single Lua script so current and pending come from one consistent snapshot; a missing current key, a negative value, or a marker older than 1 hour is a cache miss and forces a re-sum from the database under `org:{orgId}:fetch-box-usage`.

### The reservation

A create cannot check-then-insert: two concurrent creates would both read the same headroom and both succeed. Instead the reservation is written to Redis **before** the box row exists:

```text
reserve pending (Lua, atomic across the 5 keys)
  └─ project = current + pending, assert within ceilings
       ├─ violation -> release reservation, 400
       └─ ok -> caller persists the box
            └─ box.created / box.state.updated -> pending drains into current
```

Reserve and release are each one Lua script, so a concurrent reader never observes a half-applied reservation. Realization only draws pending down on a positive delta — a box entering a consuming state redeems its reservation, while one leaving merely lowers current usage. The 60 s pending TTL is the backstop: a create that dies between reserving and persisting leaks nothing permanently.

Start passes `excludeBoxId` so the box's existing contribution is subtracted before its full target is added, counting it once rather than twice.

Realization holds `box:{boxId}:quota-usage-update`. Cache updates only mutate a current key that already exists; otherwise the next re-sum picks the change up anyway.

Volumes are outside this model entirely: they are not metered and not capped. Counting live rows shares none of the machinery above, so adding a ceiling for them would need its own enforcement path rather than a sixth reservation counter.

## Failure Semantics

| Failure | Effect |
|---|---|
| Redis unavailable during a quota check | The check throws; the create fails closed |
| Cache miss or stale marker | Re-sum from the database, serialized per organization |
| Reservation leaked by a dead create | Drains on the 60 s TTL |
| Metering handler throws | Logged; the box lifecycle is unaffected |
| Two writers race an open period | Unique partial index rejects the second |
| Query cache disabled | Region type silently degrades to `shared` |

Metering is deliberately best-effort at the edges and authoritative in the database: it must never block a lifecycle operation, and the invariant that matters is enforced by a constraint rather than by careful code.

## Boundaries

Nothing inside `apps/api` reads usage periods. The tables are the integration point for an external billing service, which makes their schema a public contract: renaming a column or changing a `boxClass` value is a breaking change to a consumer that lives in another repository.

`GET /organizations/{id}/usage` reports the quota view, not the metering view — live consumption against ceilings, never history. Where a collector endpoint is configured, the same view is pushed to OTLP once a minute, five organizations at a time, under a global `org-metrics-export` lock.
