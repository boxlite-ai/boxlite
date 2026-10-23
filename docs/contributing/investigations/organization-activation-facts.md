## TL;DR

Keep the latest Box creation and start/delete times after Box cleanup.

## Details

### Review follow-up: optimistic updates outside Box transactions

At `87e0efe45`, an `AFTER` trigger updates the organization's facts row inside each
Box write transaction, so same-organization Box transactions queue on that row
until commit. The synthetic test below measured a 261 ms wait behind a 250 ms
holder. Review asked for no database triggers: the application issues the update
itself, optimistically, without a transactional guarantee.

Decision:

- The pre-deploy migration only creates `organization_activation_facts` and
  backfills it; it installs no triggers, and no later migration removes any. An
  environment that applied an earlier, unreleased revision drops its two
  activation triggers and functions, and the `boxHistoryComplete` column, manually;
  otherwise the column's `NOT NULL` makes every upsert fail.
- After `BoxRepository.insert`, `update` or `updateWhere` commits, the repository
  compares the previous and committed Box. In its own short transaction it sets
  a one-second `lock_timeout`, then upserts the row with `GREATEST`, updating only
  when a value advances. An organization without a recorded Box has no row.
- A later review removed `boxHistoryComplete`. Updates are best effort, so the flag
  never proved a complete history; consumers compare organization creation with
  the tracking start instead.

| Application Box write | Facts effect |
| --- | --- |
| Insert into a real organization | Creation is `createdAt`. |
| Warm-pool claim | Creation is the claim `createdAt` (the write time if unchanged); modification if already `started`. |
| Transfer between real organizations | None; times stay with the source. |
| Enter `started`; first `desiredState=destroyed` | Modification is the write time. |
| Stop, labels, repeated state, completion, cleanup | None. |

The write time is the `updatedAt` value `BoxRepository` sets in memory for that
write, taken from the API instance clock like `createdAt`. It can differ slightly
from the stored `updatedAt`, and clock skew between instances can reorder
near-simultaneous events by that skew.

The trigger also recorded direct destruction and physical deletion without prior
intent. No application path produces them: `Box.assertValid` rejects `destroyed`
unless deletion was requested, and both cleanup crons delete only such Boxes
(`apps/api/src/box/services/box.service.ts`, `cleanupDestroyedBoxes`,
`cleanupStaleErrorBoxes`).

| Situation | Result |
| --- | --- |
| Facts row locked | The Box commits; the follow-up waits at most one second (`lock_timeout`), then is logged and dropped. |
| Box transaction rolls back | No facts update runs. |
| Concurrent or late updates | Read Committed rechecks `WHERE` on the newest row; times never regress. |
| Update fails, or the process exits after commit | That advance is lost and logged; the Box result stands. |
| Organization deleted | The foreign key rejects the upsert; facts are not recreated. |
| Raw SQL, or instances on the previous revision | Not recorded; the next recorded event creates any missing row. |

There is no retry, outbox or backlog. A lost advance is repaired only by a later
event of the same kind for that organization. A null time therefore means none
was recorded, not proof of inactivity.

[Row-level locks §13.3.2](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)
are released at transaction end, which is why the trigger serialized Box commits.
[Read Committed §13.2.1](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED)
re-evaluates the `WHERE` clause on the updated row version, so concurrent
`GREATEST` updates cannot move a time backwards.
[`INSERT ON CONFLICT`](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT)
guarantees an atomic insert-or-update outcome under concurrency.
[`lock_timeout`](https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-LOCK-TIMEOUT)
aborts a statement that waits longer for a row or other lock, and
[`SET LOCAL`](https://www.postgresql.org/docs/current/sql-set.html) lasts only until
the transaction ends, so the bound never leaks to other users of the pooled
connection. `conditionalStartForProxy` in the same repository uses this pattern.

Rejected alternatives:

- A conditional `WHERE` inside the trigger still runs in the Box transaction.
- An outbox plus worker is durable, but adds a table, cron and retention that
  review declined.
- `EventEmitter` listeners: `updateWhere` emits before commit, and payloads lack
  the previous desired state.
- A Redis buffer like `BoxActivityService` adds a dependency with the same loss window.
- A stage flag: without triggers the cost is one primary-key `UPDATE` per
  lifecycle event, and a disabled period would silently miss events.

Rollout and rollback:

- The migration creates the table and backfills existing organizations in one
  transaction. The foreign key takes `SHARE ROW EXCLUSIVE` on `organization`, so
  organization writes wait until the backfill commits; the lock wait is capped
  at five seconds and each statement at sixty.
- During a rolling deploy, instances on the previous revision write no facts:
  their Box events are lost. The next creation, start or deletion request recorded
  by a new instance creates any missing row.
- Rolling the API back leaves the table unused; reverting the migration drops it.

Validation, on real PostgreSQL:

- [x] A Box start commits and returns while another transaction holds the facts
  row; the update times out, logs, and the next start records. Without the
  timeout, the call waits for the holder; with the trigger, the start blocks.
- [x] Rolled-back Box writes leave facts unchanged; a delayed older update does
  not replace a newer time.
- [x] A failed update keeps the Box result and logs; the next start recovers.
- [x] Box deletion keeps facts; organization deletion is not undone; the event
  table above holds.
- [x] The migration installs no triggers, so raw SQL writes stay unrecorded; an
  organization the previous revision inserts during installation gets its row
  from its first Box write.

With every non-test file restored to the trigger revision, the lock test failed
with "The Box start did not commit while the facts row was locked". After review
asked to bound the follow-up wait, the same test against the untimed update failed
with "The Box start did not return while the facts row was locked".

Nine other cases failed as well. Five compare times, and the trigger records
statement time rather than the write time. The delayed-update case timed out, and
the failed-update case failed the Box write itself. The two migration cases found
the triggers and a trigger-created row. Restoring the change passed all 13
lifecycle cases and all 1,828 API tests on PostgreSQL 17.11 and Redis.

That full run also exposed an activity calculation that threw after a committed
warm claim, failing an existing creation-admission test. It now runs inside the
logged `try`.

A local pgbench run sent the bare follow-up `UPDATE` from eight clients, 2,000
times each: 0.827 ms average latency on one organization row and 0.310 ms across
eight. The bounded update adds `BEGIN`, `SET LOCAL` and `COMMIT` round trips that
this run did not measure. This is synthetic container data, not production capacity.

### Review follow-up: migration availability

At `47a83edb1`, the usage-window migration builds two ordinary indexes. The
[review](https://github.com/boxlite-ai/boxlite/pull/2039#discussion_r4332833874)
correctly identifies a deployment write-blocking risk: neither the CLI nor
application data source sets a transaction mode, so TypeORM defaults to one
transaction for all pending migrations. The usage integration setup also uses
that default.

[PostgreSQL concurrent index builds](https://www.postgresql.org/docs/18/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY)
allow writes but cannot run inside a transaction. A failed build can leave an
invalid index; `IF NOT EXISTS` alone would skip that unusable artifact on retry.
[TypeORM transaction modes](https://typeorm.io/docs/advanced-topics/migrations/#transaction-modes)
allow one migration to opt out under `each`, while ordinary migrations keep
their own transactions. Inspection of installed TypeORM 0.3.31
`MigrationExecutor.undoLastMigration` shows that rollback ignores the migration's
`transaction=false`: unlike the review suggestion, `each` still opens a transaction.
Use `--transaction none` only when reverting this concurrent-index migration;
keep the ordinary transactional revert default for all other migrations.

Use `each` for CLI, application startup and the integration data source. Only
the usage-index migration opts out; create/drop both indexes concurrently,
preserve valid completed indexes on retry, and remove invalid leftovers before
rebuilding. The activation migration keeps its table creation and backfill atomic.
Reject ordinary index builds because they block writes; reject globally disabling
transactions because the activation migration requires one. No API changes.

- [x] Reproduce the old migration blocking a real PostgreSQL writer; keep every
  production file at its pre-fix version for that run.
- [x] Cover both tables, interrupted-build retry, rollback/reapply and migration history.
- [x] Update transaction modes and deployment/revert documentation; rerun checks.
- [x] Measure same-organization trigger contention with synthetic transactions;
  report the local result and retain production load validation as a rollout requirement.

The production-reverted regression failed at both live/archive writer assertions
with a 250 ms lock timeout; the partial-build retry failed on an existing index.
Restoring the complete fix passed all three cases. The related resource and
activation suites also passed with real PostgreSQL and Redis.

API tests and the production API build passed. Changed-source format and lint
checks passed; repository-wide format still reports generated clients, lint
reports infrastructure module-boundary errors, and `make test` stops at missing
vendored runtime sources. These checks do not establish a clean full-repository run.

On PostgreSQL 17.11 in a local Docker container, eight connections each inserted
50 Boxes using `clock_timestamp()` creation times. A single synthetic run measured:

| Trigger and organization distribution | Inserts/second | p95 statement time |
| --- | ---: | ---: |
| Disabled, same organization | 5,482 | 2.42 ms |
| Enabled, same organization | 5,134 | 2.73 ms |
| Enabled, eight organizations | 8,873 | 1.77 ms |

A separate controlled test held a facts-row update transaction for an extra
250 ms: another Box start in the same organization waited 261 ms, while a start
in another organization completed in 2.55 ms before the first transaction committed.
These are observations from synthetic local data, not production throughput targets.
Before rollout, measure p95/p99 write latency and lock waits at expected burst
concurrency and transaction duration on a representative database. Keep transactions
short; no trigger SQL or lifecycle semantics changed for this measurement.

### Latest Box lifecycle times

Replace first-activation milestones with `lastBoxCreatedAt = max(createdAt)` and
`lastBoxModifiedAt = max(startAt, deleteAt)` in the existing `include=activation`
section. Keep `observedAt`; remove compute milestones and their coverage flag
(the optimistic follow-up also removed `boxHistoryComplete`). Current Box state answers whether a Box is running.

Inspection at `13ed02038` found no `startAt` or `deleteAt` on `Box`
(`apps/api/src/box/entities/box.entity.ts`). Start means a committed transition
into `started`; delete means the first accepted `desiredState=destroyed`. The
event's own committed write time is recorded; a later generic `updatedAt` or
usage-period start does not represent it. Label edits, stop, retries, deletion completion
after acceptance, and delayed physical cleanup must not advance the maximum.

Reuse the pending facts-table migration; the optimistic follow-up above replaced
its unreleased Box triggers with an application update after commit.

Store
only organization maxima, independent of Box retention; no per-Box event ledger,
new route, usage query, or continuous-activity inference. Warm-pool claims count
as creation, and as start if already running; transfers between real organizations
are not creation/start. Backfill only the maximum retained `createdAt`; old
start/delete history is unknown, so leave modification null.

[Conditional expressions §9.18.4](https://www.postgresql.org/docs/current/functions-conditional.html#FUNCTIONS-GREATEST-LEAST)
defines null-aware `GREATEST`, suitable for monotonic maxima under row locking.
Querying current Boxes loses deletions; keeping first-use/compute facts adds
analysis outside this requested contract.

Implementation checklist:

- [x] Replace pending migration, DTO and reader; retain the existing endpoint and include selector.
- [x] Test maxima, start/restart, deletion acceptance and cleanup, irrelevant updates,
  rollback, concurrency, pool claims/transfers, backfill and missing facts on PostgreSQL.
- [x] Regenerate clients; update Backoffice validation, OpenAPI, daily report and guides.
- [x] Run required checks and update this design and the shared contract document.

Acceptance: deleting every Box leaves both maxima readable; cleanup cannot look
like renewed activity. This is an unmerged migration revision, not an upgrade of
an already deployed schema. Producer rollout still precedes consumer rollout.

### Organization contract simplification

Before this change, inspection found two branches in the existing organization routes: the original
UUID-paginated projection and the `view=metadata` registration projection.
The latter also introduced a component-identities capability probe and response
headers. The internal administrator clients can upgrade together, so these
compatibility branches add maintenance without an independent consumer requirement.

- [x] Make the existing list accept `q`, `cursor`, `limit`, `createdFrom` and
  `createdTo` directly. Always return registration fields, ordered by creation
  time and ID with filter-bound cursors.
- [x] Make registration fields required on the existing detail. Retain
  `include=usage,activation` to control additional queries; neither section is
  loaded by default.
- [x] Remove `view`, metadata-only branching, capability headers and consumer
  preflight requests. Use `invalid_organization_query` for invalid organization
  queries. Keep operation IDs; regenerate clients.
- [x] Let the consumer accept additive upstream fields while exposing only its
  documented projection. Reject missing required fields and unrequested usage
  or activation sections.
- [x] Check other related routes: historical resource and billing aggregates
  have distinct query semantics and need no view consolidation.
- [x] Test the direct HTTP contract, default query isolation, date boundaries,
  pagination and consumer projection; update API docs and the shared guide.

This intentionally changes the internal default detail and cursor contract.
Finish upgrading every producer before enabling the consumer, discard old list
cursors, and roll back the consumer before the producer. There is no mixed-version
fallback. No schema migration is needed for this contract simplification.

[AIP-180, Guidance and Adding new components](https://google.aip.dev/180) permits
teams controlling limited clients to choose their compatibility needs; we adopt
additive fields but explicitly replace the unreleased dual-mode contract.
[AIP-160, Guidance](https://google.aip.dev/160) supports filtering on an existing
list; the existing typed date parameters suffice without a filter language.
Keeping both modes or adding another metadata endpoint would retain the problem.

### Scope and contract

`GET /api/admin/organizations/{organizationId}?include=activation` adds creation
and start/delete timestamps to the existing detail.
Registration fields are always included. `include=usage,activation` selects both
optional sections; omitting include reads neither. Box deletion preserves evidence;
organization deletion removes it. Administrator authentication is required.

The existing list directly accepts creation dates, search and filter-bound cursors.
The existing operation IDs and response models remain; registration fields are required,
activation is optional. Detail remains flat and missing organizations return 404.
Invalid organization queries return `invalid_organization_query`.
There are no duplicate metadata paths, view branches, or capability headers/probes.

All producers must be upgraded before updated consumers are enabled. Mixed-version
traffic is not supported; old UUID-only list cursors must be discarded. Callers needing
current-month usage must explicitly request it. Rollback order is consumer then producer.

| Field | Meaning |
| --- | --- |
| `lastBoxCreatedAt` | Maximum retained Box creation or warm-pool claim time. |
| `lastBoxModifiedAt` | Maximum observed successful-start or accepted-deletion time; see the event definition above. |
| `observedAt` | Database observation time for this response. |

Null means none was recorded, not inactivity. Current Box state, available through the
existing Box/detail queries, answers whether a Box is running. Recent start/delete
time is not proof of user interaction, CPU utilization, or retention. Automatic
starts/deletions also count. Facts survive Box deletion and disappear with the organization.

### Related work and lessons

The source at `72f56d099` provides the following boundaries:

- `BoxRepository.insert` and `update` commit Box writes in a transaction
  (`apps/api/src/box/repositories/box.repository.ts:78–94,170–190`).
- Warm-pool claims replace organization and creation time
  (`apps/api/src/box/services/box.service.ts:397–449`). Destroyed Boxes are later
  physically removed (`1351–1382`), so counting current Boxes loses history.

[PostgreSQL triggers](https://www.postgresql.org/docs/current/trigger-definition.html)
run in the originating transaction, so an unreleased revision covered raw writes and
old instances, but held the facts row lock until every Box commit. The optimistic
follow-up accepts application-only, best-effort coverage instead. A separate table
avoids altering existing responses that serialize organizations.

### How it works

An additive, transactional pre-deploy migration creates `organization_activation_facts`
and backfills the maximum retained Box creation time. Organizations already present
keep only retained creation times. The migration installs no triggers. The table
references organizations with cascade deletion, but never references Boxes.

Migration lock acquisition is limited to five seconds and individual statements to
sixty seconds; contention or excessive data causes rollback, not partial
installation. Production data volume has not been measured.

After `BoxRepository` commits an insert or update, it applies the event table in the
optimistic follow-up: inserts and claims advance the creation maximum; successful
starts and first deletion requests advance the modification maximum. Repeated
writes, stops, label changes, deletion completion and cleanup leave it unchanged.
Pool-only activity and transfers between real organizations are ignored.

The follow-up upsert runs in its own short transaction and never touches Boxes.
Its insert path checks the foreign key with a `FOR KEY SHARE` lock on the
organization row, which waits only behind that row's deletion or another `FOR
UPDATE` lock, within the same timeout. Box transactions therefore hold no facts lock, and
concurrent facts updates serialize only for one statement. A wait past the
one-second `lock_timeout` aborts the update, which is logged and dropped. The read
uses one SQL statement.

### Validation

Real PostgreSQL tests drive `BoxRepository` and `OrganizationService` through maxima,
successful start/restart, deletion acceptance, delayed cleanup, unrelated changes,
failed writes, a held facts lock, delayed and failed updates, organization deletion,
pool claims/transfers, backfill, and migration upgrade/revert. HTTP tests retain
administrator guards, date filters and optional-section isolation. The consumer
checks timestamp types, missing fields, organization identity and scoped access.
Go and TypeScript client request tests send each new optional query parameter
(`createdFrom`, `createdTo`, `include`) only when set, against a local server.
Generated clients and the daily-report example use the same two timestamps.
Production migration duration and large-organization contention remain unmeasured.

The focused lifecycle, organization-query, provider and overview suite passes 53
checks with real PostgreSQL, including 13 lifecycle scenarios. Before production
edits, the new contract check failed because the old reader omitted both latest
fields. The final lifecycle suite creates no usage tables, checking that this
contract depends only on organization and Box writes.
Run with `make test:apps:api FILTER='AdminOrganizationActivationService|AdminOrganizationOverviewService|AdminProviderController|organization queries|Admin overview'`
and disposable PostgreSQL configured through `DB_*`.

Focused source lint passes. Three generated clients were regenerated twice without
Nx cache; all 532 generated files matched on the second run.

Repository-wide format still reports 199 generated-client files, and lint reports three infra
module-boundary errors. The full test target stopped in an infra Pulumi log test,
and its CLI suite failed while cloud credentials and a loopback proxy were set.
The API build and spec type check pass; the apps build fails only in the runner
version check and dashboard bundling. These are local checks, not production
rollout or migration-capacity evidence.
