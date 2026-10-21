# Create a Box from a filesystem snapshot

New filesystem snapshots have their own lifetime. Save their ID before deleting
the source; query and create children through the runtime handle afterward:

```python
s = await source.snapshot.create(name="checkpoint")
b = await runtime.create_from_snapshot(s.id, name="child-b")
c = await runtime.create_from_snapshot(s.id, name="child-c")
await runtime.remove(source.id, force=True)
assert (await runtime.snapshot_get(s.id)).id == s.id
d = await runtime.create_from_snapshot(s.id, name="child-d")
await runtime.snapshot_remove(s.id)
```

Native children initially have `stopped` state; call `await child.start()`.
The cloud API waits for startup before returning. Every child has a new Box and
container identity, fresh guest boot state, and a separate writable disk. Writes
cannot reach the immutable snapshot or siblings. Children remain usable after
snapshot deletion because their disks are fully materialized, without a backing
reference to the snapshot. This trades extra copy I/O and disk space for simple
ownership. No startup-time or performance guarantee is implied.

Only the container filesystem is restored. RAM, process state, guest boot disk,
external mounts, caches, host port mappings and secret-injection rules are not
inherited. Omitting `options` inherits the sanitized source boot configuration.
Supplying `options=BoxOptions(...)` provides a complete new configuration and
explicit external mounts; the source image identity still comes from the
snapshot. The remote API applies ordinary mount permissions and Box quotas.
Memory capture and restore remain unsupported in production; see the
[mock contract](memory-snapshots.md).

Snapshot disks and a versioned boot manifest live under the owning runtime's
`snapshots/<native-id>/`. SQLite metadata remains queryable after source deletion.
The cloud catalog records organization, owning runner, source identity and an
opaque public snapshot ID in PostgreSQL. It has no source-Box cascade dependency.
Public responses omit native paths and runner credentials. An ID from another
organization is not found. Format version or CPU architecture incompatibility,
unreadable storage, missing snapshots and provisioning failure are errors, with
no image fallback. Failed staging copies are removed before publication.

Creation uses the snapshot's owning, available runner. To create on another
runner, explicitly copy the snapshot first:

```python
remote_s = await runtime.snapshot_copy(s.id, runner_id=destination_runner_id)
remote_b = await runtime.create_from_snapshot(remote_s.id, name="remote-child")
```

The destination must be available in the source region and Box class. The cloud
API streams the existing migration `.boxlite` archive between authenticated
runners, verifies format, checksums and architecture, and creates a new immutable
snapshot with its own ID. Temporary Boxes never boot. The original and copy have
independent lifetimes; neither owns a disk backing reference to the other. Source
boot options come from the sanitized catalog, while new external mounts and
caches must be supplied explicitly in child options. Copying does not transfer
cache contents or change ordinary cache scheduling semantics.

`snapshot_copy_enabled` declares support; native local runtimes and standalone
reference servers return Unsupported through the SDK. Python/Rust use
`snapshot_copy`, Node uses `snapshotCopy`; native Go/C reuse their existing
snapshot and archive operations and have no runner-selector copy method.
The cloud route is `POST /snapshots/{id}/copies` with `{ "runner_id": "...",
"name": "optional-copy-name" }`. Omitting name generates a unique name. Requests
need WRITE_BOXES permission. Another organization's snapshot appears absent.
Transfers have a four-minute API deadline and an 8 GiB compressed archive limit;
disk expansion uses the existing migration importer. No performance guarantee
is implied. Interrupted requests are not automatically retried: a lost completion
reply or process crash can require native/API catalog reconciliation, as below.

An unavailable owner is rejected. A local SDK can only access snapshots in its
own runtime home. A restored source disk may still have
a backing reference to S; deleting S is then refused until that reference ends.
Legacy snapshots made before independent storage remain source-owned and lack
the required boot manifest; create-from rejects them explicitly. Re-capture the
source to obtain a new independent snapshot.

Rootfs-path sources and custom guest kernels cannot currently produce the
portable boot manifest. The cloud catalog does not automatically import older
native snapshots: use the native source handle to inspect them, or re-capture
through the API before using the cloud's independent snapshot-ID routes.

Capture, materialization and deletion share a runtime operation lock. The API
and runtime catalogs have separate commits: a process or network failure between
them may require operator reconciliation of a runtime snapshot not published in
the API catalog. Do not infer success from a disconnected request; retain logs
and query the snapshot before retrying.

The cloud routes are `GET/DELETE /snapshots/{id}` and
`POST /snapshots/{id}/boxes` with `{ "name": "child", "options": ... }`.
`create_from_snapshot_enabled: true` declares this independent-ID surface.
The standalone CLI/reference servers currently advertise false for these global
routes; their existing source-scoped snapshot handles still work while the
source is present. Native runtimes and the runner-backed cloud API implement the
independent-ID surface. The SDK does not silently emulate an unsupported server.

Node uses `createFromSnapshot`, `snapshotGet`, `snapshotRemove`. Rust uses the
corresponding snake_case methods. Go uses `CreateFromSnapshot(ctx, id, image,
opts...)`, `SnapshotGet`, `SnapshotRemove`; its new configuration is explicit.
C exposes `boxlite_create_from_snapshot` and `boxlite_runtime_snapshot`, using
the existing asynchronous callback ownership conventions.

Run `make test:runner-ci:children` for the real SDK/API/runner lifecycle,
`make test:runner-ci:snapshot-copy` for two-runner copy, persistence and isolation,
`make test:runner-ci:children-local` for native format/permission failures, and
`make test:integration:snapshots` for existing VM regression tests. Failed probes
retain their disks and write identifiers to `.apps-local/runner-acceptance/`.
