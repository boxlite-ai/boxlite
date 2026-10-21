# Filesystem snapshots

Capture a named, immutable copy of the Box's current container disk through the
local SDK or Python REST → API → runner. Image layers alone do not represent the
snapshot: added, modified and deleted files and their permissions are captured.

```python
snapshot = await box.snapshot.create(name="checkpoint")
assert snapshot.snapshot_type == "filesystem" and not snapshot.is_mock
snapshots = await box.snapshot.list()
snapshot = await box.snapshot.get("checkpoint")  # None when absent
await box.stop()
box = await runtime.get(box.id)
await box.snapshot.restore("checkpoint")
await box.start()
```

Restore requires a stopped Box and cold boots it. RAM, processes and device state
are never restored. Only `disks/disk.qcow2` is captured. The runtime boot disk is
recreated; external virtiofs mounts and cache contents are outside the capture.
Snapshot metadata does not capture external mount specifications or their host
paths. Restoring this Box retains its existing mount configuration.

Running capture freezes guest filesystems when the guest RPC is available,
pauses the VM process, flattens the disk's resolved backing chain into a separate
read-only QCOW2 file, resumes the VM and thaws its filesystems. The live disk inode
is never replaced during capture. Guest freeze is best effort with a five-second
RPC deadline; the consistency contract is **crash-consistent**, not application-
consistent. Applications requiring stronger guarantees must flush/quiesce their
own state before capture. Capture duration depends on allocated disk data.

An owned task completes capture and thaw even if the requesting future is
cancelled. Disk errors resume/thaw before returning and remove incomplete output.
A freeze timeout still triggers thaw because the guest may have frozen after the
response deadline. Thaw RPC failure is logged; a host or guest crash during this
sequence still requires operator recovery. This is not a machine-state checkpoint.

Names are unique per source Box, up to 255 bytes, and cannot start with `.` or
contain slash, backslash or NUL. Query/list/delete use persisted SQLite metadata.
Delete with `await box.snapshot.remove("checkpoint")`. Deletion rejects a disk
still referenced by a restored Box or a legacy backing chain. New snapshots use
independent runner-local storage and survive source deletion; older per-Box
snapshots remain source-owned. See [creating children](create-from-snapshot.md)
for runtime lookup by ID, boot manifests and runner placement.

The API authenticates organization ownership, routes to the Box's assigned
runner and never auto-starts a stopped source for capture. It advertises
`snapshots_enabled: true`; `memory_snapshots_enabled` stays false. Native storage
paths are omitted from REST metadata. Missing resources, duplicate names, invalid
names, active restore and unsupported types return typed errors. A disconnected
client must query the chosen name before retrying; creation is not implicitly
idempotent.

Go uses `box.Snapshots().Create/Get/List/Remove/Restore(ctx, ...)`. C exposes
`boxlite_box_snapshot` with JSON operation `create`, `get`, `list`, `remove` or
`restore`; its callback follows the existing event-dispatch ownership rules.
Memory requests remain explicitly unsupported in every production facade.

Real qualification: `make test:runner-ci:fs`; native immutability regression:
`make test:runner-ci:fs-local`; existing VM regressions:
`make test:integration:snapshots`. See the [F4 verification record](../contributing/investigations/2026-10-22-f4-filesystem-snapshots.md).
