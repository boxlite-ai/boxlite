# Checkpoints (release candidate)

A checkpoint preserves a paused Linux x86_64/KVM guest as two files:
`snapshot.mem` and `snapshot.qcow2`. Shared files remain external resources.
Callers supply stable storage references when exporting and explicit roots and
file descriptors when importing. Imported boxes appear **Paused**; resume is explicit.

## Support and lifecycle

Supported default configurations automatically use the checkpoint owner, DAX and
checkpoint resource limits. There is no creation switch. Other platforms and
unsupported configurations keep ordinary starts and disk operations; checkpoint
operations report the concrete restriction. A running older shim needs an explicit
stop and restart before using the new protocol. Reconnection never changes its mode.

For an enabled jailer, `max_open_files: null` selects automatic FD sizing. Ordinary
mode keeps an effective 1,024-descriptor default. Owner mode reserves three bounded
16,384-descriptor sets plus 256 control/disk slots: live, captured and prepared
resources during export; received, C-ABI-duplicated and restoration resources during
import. An explicit numeric cap stays exact through serialization and SDK conversion;
preflight refuses a transfer that cannot fit its complete set and existing FDs.
Disabling the jailer retains its opt-out behavior. Shared file contents do not add
memory-image file-size allowances; RAM, init bytes and anonymous DAX pages do.

| State | Disk snapshot, clone, export | Checkpoint export | Disk restore |
| --- | --- | --- | --- |
| Running | Internally capture, then continue Running | Refuse | Refuse |
| Paused | Refuse before staging or disk mutation | Save; remain Paused | Refuse |
| Stopped | Allow | Refuse | Allow |
| Other or unknown | Refuse | Refuse | Refuse |

Each lifecycle/storage operation takes a nonblocking reservation across processes.
Conflicts return `Busy`. A Running disk capture drains and copies the frozen view
without replacing the live disk. Batch clones share one copied base; children and
export compression are created after the source resumes.
Snapshot removal also refuses an active owner capture, even if its initiating
process no longer holds the host-side reservation.

## Export, inspect and import

```sh
boxlite create --name web -v /srv/live/data:/data alpine:latest sleep 3600
# Stop every host writer of external resources before making this assertion.
boxlite pause --host-writers-stopped web
boxlite checkpoint export web /srv/checkpoints/web --bindings /srv/export-bindings.json
boxlite checkpoint inspect /srv/checkpoints/web
boxlite checkpoint import /srv/checkpoints/web --name web-copy --bindings /srv/restore-bindings.json
boxlite resume web-copy
```

`pause` stops guest vCPUs and devices. It does not stop host writers. Keep external
storage at its coordinated recovery point until export finishes; retain that point
for the lifetime of the checkpoint. Export never implicitly starts or pauses a box.

Inspection reads the memory image and lists dependencies and the paired disk digest.
It opens no shares and provisions no runtime or box. Import additionally checks the
QCOW2, external objects and exact readonly boot disk before guest execution.

The output directory contains exactly these entries:

```text
web/
├── snapshot.mem       # Version 9: checked metadata, RAM and CPU/device/FUSE state
└── snapshot.qcow2     # Standalone container disk, without a backing file
```

The binding JSON is an **input**, stored outside that directory. Export publishes
through a private staging directory and atomic no-overwrite rename after syncing
both files and the directory. Keep the destination unchanged while export or
rollback is in flight. On invalidation or parent-sync failure, rollback quarantines
the name and removes only its verified directory and two members. A changed name,
member or layout is preserved; the error reports the last observed parent and any
quarantine residue. This ownership contract does not promise atomic conditional
unlink against arbitrary concurrent mutation by the same host user. No unsynced
publication is reported as success.

## External resource bindings

The Rust API accepts `CheckpointExportProvider` and `CheckpointImportProvider`.
Export preparation supplies retained object descriptors and their share, guest inode,
access-role and alias metadata. Providers return stable
`(resource_id, recovery_point, object_key)` references. Import supplies recovered
roots, O_PATH object descriptors, independently opened handles and DAX descriptors,
and a lease. The runtime holds the import lease until box removal, releasing it
after its writers have exited. References and roots must remain recoverable after source destruction
and across later runtime restarts; a temporary FD alone is not durable retention.

`LocalCheckpointProvider` adapts explicit local bindings. A configuration has this
shape (the object list is illustrative; every retained external object must be bound):

```json
{
  "shares": { "BoxLiteShared": "runtime-shared", "uservol0": "app-data" },
  "resources": {
    "runtime-shared": {
      "recovery_point": "cut-42",
      "source_root": "/srv/live/runtime-shared",
      "root": "/srv/recovery/cut-42/runtime-shared",
      "objects": { "root": { "path": "." } }
    },
    "app-data": {
      "recovery_point": "cut-42",
      "source_root": "/srv/live/data",
      "root": "/srv/recovery/cut-42/data",
      "objects": {
        "root": { "path": "." },
        "database": { "path": "database.sqlite" }
      }
    }
  },
  "boot_disks": { "FULL_SHA256_FROM_INSPECTION": "/srv/boot/exact.ext4" }
}
```

`source_root` is optional and used only to associate source descriptors with explicit
locators. Import matches resource/recovery-point IDs exactly. Relative locators open
beneath a pinned root without parent traversal or symlink escape. There is no tree
search, share archive or background retention service. `BoxLiteShared` is required
like any other external share; coordinate its recovery root explicitly.

An unlinked retained object cannot be recovered from a path. Its locator can instead
supply inherited descriptor numbers:

```json
{ "fd": 12, "handles": { "7": 13 }, "dax_read": 14, "dax_write": 15 }
```

`fd` identifies the retained object. Handle/DAX descriptors must independently have
the saved access/status flags and identify that object. The provider duplicates
inherited FDs before use. Missing objects or roles fail explicitly. Cached directory
names and cookies alone do not demand object FDs, including deleted listing-only
names and `.`/`..`. Hard links and aliases must preserve the same recovered inode.

The readonly guest boot disk is an external dependency, not a third artifact. The
runtime can use an exact digest-matching cached base or the explicit `boot_disks`
binding. Its full bytes are checked and its lifetime is pinned. Import never rebuilds
a substitute on cache miss. The private imported container remains QCOW2 through
resume, stopped cold starts, disk snapshots and later checkpoints.

## Failure and compatibility

Import binds resources through SCM_RIGHTS after sandbox installation and before any
vCPU is released. It publishes only after the owner confirms Paused. Failure stops
and joins the new shim before removing attempt-owned storage; caller recovery points,
mounts and original checkpoint files remain caller-owned.

Cancellation or an uncertain capture outcome stops the source owner and joins writers
before cleanup. A missing or corrupt shim identity file while its PID is live is an
uncertain join: storage and leases are retained, and the unverified PID receives no
signal. Exiting the launcher or queuing a cgroup kill alone does not prove that
descendant writers exited. Known export failures preserve Paused. Never blindly retry a control
operation whose outcome is unknown. Ordinary backend captures retain their documented
consistency limits and always resume/thaw after a known copy failure.

Older full checkpoints are refused with an explicit unsupported-version error and
left intact. No RAW container conversion or share extraction path is provided.
Ordinary disk-only `.boxlite` archives retain their existing format and compatibility.
Checkpoint endpoints are available in Rust and the embedded CLI; no SDK or REST
checkpoint endpoints are added.
