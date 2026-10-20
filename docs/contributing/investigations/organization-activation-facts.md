## TL;DR

Persist organization activation evidence when Boxes and usage periods are written, preserving uncertainty about earlier history.

## Details

### Scope and contract

`GET /api/admin/organizations/{organizationId}?view=metadata&include=activation`
adds creation evidence and the earliest recorded positive-CPU usage period to the
existing detail. Omit `view` to preserve the old response and default usage behavior.
`view=metadata` makes usage opt-in; `include=usage,activation` selects both sections.
Box deletion preserves evidence; organization deletion removes it.
Administrator authentication is required.

The existing list also accepts `view=metadata`, creation dates and registration
cursors. The previously proposed `/metadata` routes are removed before release.
The existing operation IDs and response models remain; registration and activation
fields are optional additions. Detail remains flat and missing organizations return
404. Invalid metadata queries retain `invalid_organization_metadata_query`.

An old producer ignores `view`, so a consumer must first read the existing
`GET /api/admin/component-identities` and require its
`X-BoxLite-Admin-Capabilities: organization-metadata-v1` response header. The body is
unchanged. Without the capability, do not request metadata: old detail would read
usage implicitly. No new discovery endpoint is introduced.

This probe identifies one instance, not an entire deployment. All producers must be
upgraded, with older revisions unable to receive traffic, before metadata-view consumers
are enabled. Mixed-version producer traffic is not supported during consumer activation.
Metadata responses repeat the header for final consumer validation; it cannot prevent
an old instance's usage read. Rollback order is consumer first, then producer.

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
receives complete tracking after commit. HTTP tests must cover unchanged legacy
response/usage behavior, explicit metadata/activation selection, missing capability
protection and removal of the duplicate paths. Production migration duration and
large-organization contention have not been measured.

The combined metadata, provider and activation suite passed 48 tests, including real
PostgreSQL migration/concurrency tests. The command was
`make test:apps:api FILTER='AdminOrganization|AdminProvider|organization metadata|Admin overview'`.
