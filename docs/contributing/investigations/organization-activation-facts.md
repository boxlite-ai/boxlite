## TL;DR

Keep the latest Box creation and start/delete times after Box cleanup.

## Details

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
rebuilding. The activation migration retains its atomic triggers and backfill.
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
section. Keep `boxHistoryComplete` and `observedAt`; remove compute milestones
and their coverage flag. Current Box state answers whether a Box is running.

Inspection at `13ed02038` found no `startAt` or `deleteAt` on `Box`
(`apps/api/src/box/entities/box.entity.ts`). Start means a committed transition
into `started`; delete means the first accepted `desiredState=destroyed`, or a
direct transition into `destroyed` without an earlier request. Record their
database statement timestamps. Neither generic `updatedAt` nor usage-period
starts represent these events. Label edits, stop, retries, deletion completion
after acceptance, and delayed physical cleanup must not advance the maximum.
A direct physical delete without prior deletion intent counts at deletion time.

Reuse the pending facts-table migration and transactional Box triggers. Store
only organization maxima, independent of Box retention; no per-Box event ledger,
new route, usage query, or continuous-activity inference. Warm-pool claims count
as creation, and as start if already running; transfers between real organizations
are not creation/start and make destination history incomplete. Backfill only
the maximum retained `createdAt`; old start/delete history is unknown, so leave
modification null and history incomplete. Missing facts also report incomplete.

[PostgreSQL trigger behavior §37.1](https://www.postgresql.org/docs/current/trigger-definition.html)
puts AFTER triggers in the source transaction, covering raw/old application
writes and rollback. [Conditional expressions §9.18.4](https://www.postgresql.org/docs/current/functions-conditional.html#FUNCTIONS-GREATEST-LEAST)
defines null-aware `GREATEST`, suitable for monotonic maxima under row locking.
Application events can miss writes; querying current Boxes loses deletions;
keeping first-use/compute facts adds analysis outside this requested contract.

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
| `boxHistoryComplete` | Creation/start/delete tracking covers the organization lifetime; false for preexisting or transferred history. |
| `observedAt` | Database observation time for this response. |

Null with incomplete history is unknown. Current Box state, available through the
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
PostgreSQL executes a trigger in the originating statement's transaction:
failure rolls both changes back. `AFTER` triggers see the final row and are
suited to propagating changes to another table.
[Trigger behavior, sections on transactionality and AFTER triggers](https://www.postgresql.org/docs/current/trigger-definition.html).

Application dual writes would leave old instances uninstrumented during rolling
deployment. An event listener would inherit the existing delivery gap. Database
triggers cover both versions without adding another queue or changing billing.
A separate table avoids altering existing responses that serialize organizations.

### How it works

An additive, transactional migration creates `organization_activation_facts`,
installs triggers, and backfills the maximum retained Box creation time.
Organizations already present have incomplete lifecycle history; an organization
insert trigger initializes future organizations with complete lifecycle history.
The table references organizations with cascade deletion, but never references Boxes.

Trigger installation locks source tables against concurrent writers until commit.
No API instance can commit an unobserved organization/Box write between
installation and backfill. Migration lock acquisition is limited to five seconds
and individual statements to sixty seconds; contention or excessive data causes
rollback, not partial installation. Production data volume has not been measured.

Box inserts and claims advance the creation maximum. Successful starts and first
delete acceptance advance the modification maximum, including direct destruction
or physical deletion without prior intent. Repeated writes, stops, label changes,
delete completion and cleanup leave it unchanged. Pool-only activity is ignored.
Transfers between real organizations mark the destination incomplete and do not
attribute the source's lifecycle times to it. There is no usage-table trigger.

Writes lock source rows before their organization's facts row. Facts updates never
read or lock Boxes or organizations. Organization creation owns its row
before inserting facts; deletion cascades only into facts. The read uses one SQL
statement. Concurrent maximum updates therefore serialize on one facts row without
introducing a reverse facts-to-source lock path.

### Validation

Real PostgreSQL tests exercise maxima, successful start/restart, deletion acceptance,
delayed cleanup, direct removal, unrelated changes, rollback, concurrent creates,
pool claims/transfers, backfill and migration installation. HTTP tests retain
administrator guards, date filters and optional-section isolation. The consumer
checks timestamp types, missing fields, organization identity and scoped access.
Generated clients and the daily-report example use the same two timestamps.
Production migration duration and large-organization contention remain unmeasured.

The focused lifecycle, organization-query, provider and overview suite passes 52
checks with real PostgreSQL, including 12 lifecycle scenarios. Before production
edits, the new contract check failed because the old reader omitted both latest
fields. The final lifecycle suite creates no usage tables, checking that this
contract depends only on organization and Box writes.
Run with `make test:apps:api FILTER='AdminOrganizationActivationService|AdminOrganizationOverviewService|AdminProviderController|organization queries|Admin overview'`
and disposable PostgreSQL configured through `DB_*`.

Focused source lint passes. Three generated clients were regenerated twice without
Nx cache; all 532 generated files matched on the second run. Repository-wide
format still reports 201 generated-client files, lint reports three infra
module-boundary errors, and the full test target cannot build missing vendored
runtime dependencies. API production and all three client builds pass. These are local
checks, not production rollout or migration-capacity evidence.
