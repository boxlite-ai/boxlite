# F5: copy immutable snapshots between runners

## Scope and prior implementation

F5 already cold-creates independent children on a snapshot's owner. This extension
removes the cross-runner storage obstacle through an explicit copy operation; it
does not migrate running VMs or synchronize external volumes. The user's renewed
F5 request continues the existing attempt ledger at round 7.

Existing Box migration (`apps/runner/pkg/runner/v2/executor/migrate.go`) exports a
`.boxlite` archive, transfers it through S3 and imports a stopped Box. Reuse the
same runtime export/import implementation, checksum verification, format checks,
disk flattening and staging cleanup. A never-started snapshot child can be
exported: `clone_export.rs` only needs its container disk. Import creates a new
native identity. The independent snapshot manager can capture that stopped disk
and outlive the temporary Box.

For this synchronous immutable copy, stream the archive through authenticated
API-to-runner requests instead of extending parked-Box migration jobs or requiring
an S3 installation. This avoids changing source Box ownership and the migration
rollback state machine. Node's fetch requires `duplex: 'half'` for a streamed
request body ([Undici documentation](https://github.com/nodejs/undici#requestduplex)).
No archive is buffered in API memory. Runner addresses and credentials come only
from the existing runner catalog, never caller-supplied URLs.

## Interface and ownership

`runtime.snapshot_copy(id, runner_id, name=None)` calls
`POST /snapshots/{id}/copies` with `runner_id` and optional `name`. It returns a
new snapshot ID. Node exposes `snapshotCopy`; Rust exposes `snapshot_copy`.
Local runtimes and standalone reference servers return Unsupported; only the
runner-backed API advertises `snapshot_copy_enabled`. Memory snapshots remain
unsupported. Existing native Go/C snapshot and archive interfaces are reused.

The API checks organization ownership and WRITE_BOXES permission before I/O and
requires the destination to be available in the source region and Box class.
The new catalog record belongs to the same organization and source lineage, but
owns independent storage on the destination. Creating from either ID retains
explicit owner placement. Source deletion, original snapshot deletion and copy
deletion cannot invalidate other snapshots or materialized children.

Source runner: create a stopped temporary child with no mounts, export its disk,
remove the child, stream the archive, remove the temporary archive directory.
Destination: receive into a bounded temporary file, import without booting,
capture an independent snapshot, remove the temporary Box and archive. An
architecture header is checked against the destination before import, supplementing
the archive's existing format and checksum validation. Public boot configuration
is copied from the sanitized catalog; no runner absolute path, cache or external
mount is inherited. Explicit child options resolve mounts on the destination.

## Failure and consistency

The operation copies an immutable crash-consistent filesystem point. It does not
freeze a live source or improve application consistency. Streaming is limited to
8 GiB compressed and four minutes, with no automatic retry after ambiguous writes.
Native disk operations finish under an owned context so HTTP cancellation cannot
race temporary-file cleanup. Ordinary failure removes temporary Boxes/files;
catalog publication failure removes the newly created native snapshot. A process
crash or lost completion response retains the existing F4/F5 reconciliation limit:
an unpublished native snapshot can require operator cleanup. Log identifiers,
never credentials. No distributed atomicity or automatic crash-orphan GC claim.

## Validation

First observe the missing copy behavior with an API boundary test, then implement
and rerun. Unit tests cover tenant ownership, available destination selection,
stream transport, typed errors and publication rollback. Real two-runner SDK
acceptance verifies modified/deleted files and permissions, cold identities,
independent children, original/source deletion, restart persistence, explicit
cache mounts, malformed archives and cleanup. Retain failure scenes before
cleanup. Reuse the existing children and migration regression targets. Finally
exercise the combined snapshot/Swarm/cache path using two local runner processes
on this Mac; it does not establish separate-physical-host behavior.
