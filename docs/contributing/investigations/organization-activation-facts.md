## TL;DR

Persist organization activation evidence when Boxes and usage periods are written, preserving uncertainty about earlier history.

## Details

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
evidence and the earliest recorded positive-CPU usage period to the existing detail.
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
| `firstObservedBoxCreatedAt` | Earliest retained Box creation or warm-pool claim recorded for this organization. |
| `boxHistoryComplete` | Creation tracking covered the organization's entire lifetime. False for organizations predating this migration or receiving a Box from another real organization. |
| `firstRecordedComputeAt` | Earliest positive-CPU allocation period in the retained ledger, including later periods recorded by reconciliation. |
| `computeHistoryComplete` | Always false: the ledger does not prove complete execution history. |
| `observedAt` | Database observation time for this response. |

For a new organization, complete creation history and a null creation timestamp
mean no Box creation or claim has committed. For an older organization, a null
timestamp means unknown. A null compute timestamp never proves no execution.
These facts describe organizations, independently of changing user identities.

### Related work and lessons

The source at `72f56d099` provides the following boundaries:

- `BoxRepository.insert` and `update` commit Box writes in a transaction
  (`apps/api/src/box/repositories/box.repository.ts:78–94,170–190`).
- Warm-pool claims replace organization and creation time
  (`apps/api/src/box/services/box.service.ts:397–449`). Destroyed Boxes are later
  physically removed (`1351–1382`), so counting current Boxes loses history.
- Usage writers share `createUsagePeriod` (`usage.service.ts:192–209`), but their
  events are not durable and reconciliation never reconstructs missed time
  (`423–431,542–545`). A recorded period is evidence, not complete execution history.
- Archiving moves periods in one transaction (`usage.service.ts:509–534`).

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
installs triggers, and backfills retained Box and current/archive usage evidence.
Organizations already present have incomplete creation history; an organization
insert trigger initializes future organizations with complete creation history.
The table references organizations with cascade deletion, but never references Boxes.

Trigger installation locks source tables against concurrent writers until commit.
Backfill reads both usage tables in one statement, preserving the archive boundary.
No API instance can commit an unobserved organization/Box/period write between
installation and backfill. Migration lock acquisition is limited to five seconds
and individual statements to sixty seconds; contention or excessive data causes
rollback, not partial installation. Production data volume has not been measured.

Box inserts and claims update an existing facts row only when the recorded minimum
changes. Pool-only activity is ignored. Moving a Box between real organizations
makes the destination's creation history incomplete without assigning its original
creation time to that destination. Usage inserts update the minimum only for
finite positive CPU allocation. Archive writes need no new trigger.

Writes lock source rows before their organization's facts row. Facts updates never
read or lock Boxes, usage rows, or organizations. Organization creation owns its row
before inserting facts; deletion cascades only into facts. The read uses one SQL
statement. Concurrent minimum updates therefore serialize on one facts row without
introducing a reverse facts-to-source lock path.

### Validation

Real PostgreSQL tests run the migration and exercise rollback, concurrent creates,
warm-pool claims, Box and organization deletion, old-organization uncertainty,
cross-organization transfer, positive CPU versus storage-only periods, and migration
down/up. HTTP tests cover validation, administrator guards, and response shape.
The PostgreSQL suite covers a writer blocked by migration installation that
receives complete tracking after commit. HTTP tests cover direct date filters, required
registration fields, explicit usage/activation selection, default omission of both
sections, invalid parameters and removal of duplicate paths. Production migration duration and
large-organization contention have not been measured.

The organization query, provider and overview suite passes 40 tests, including real
PostgreSQL date-window and shared-millisecond pagination checks. Run it with
`make test:apps:api FILTER='AdminOrganizationOverviewService|AdminProviderController|organization queries|Admin overview'`
and a disposable database configured through `DB_*`. This verifies the revised query
contract; it does not establish production rollout or migration capacity.

The API production build and focused source lint pass. Repository-wide format checks
report generated-client formatting, lint reports infra module-boundary errors, and the
full test target cannot build missing vendored runtime dependencies. The full apps build
also requires runner version configuration and an unavailable dashboard dependency.
These checks remain incomplete; the focused query tests are not a full-repository pass.
