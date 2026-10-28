# Checkpoints (release candidate)

A checkpoint preserves a paused Linux x86_64/KVM guest as two files:
`snapshot.mem` and `snapshot.qcow2`. Shared files remain external resources.
The runtime records mount configuration and root-relative object paths automatically.
Import resolves the target runtime’s prepared directories and opens each object anew. Imported boxes appear **Paused**; resume is explicit.

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
boxlite checkpoint export web /srv/checkpoints/web
boxlite checkpoint inspect /srv/checkpoints/web
boxlite checkpoint import /srv/checkpoints/web --name web-copy
boxlite resume web-copy
```

`pause` stops guest vCPUs and devices. It does not stop host writers. Keep external
storage unchanged through export and import. Prepare the configured external directories and exact readonly boot disk on the
target runtime before importing. Keep those dependencies available for the imported box’s lifetime. Export never implicitly starts or pauses a box.

Inspection reads the memory image and lists dependencies and the paired disk digest.
It opens no shares and provisions no runtime or box. Import additionally checks the
QCOW2, external objects and exact readonly boot disk before guest execution.

The output directory contains exactly these entries:

```text
web/
├── snapshot.mem       # Version 9: checked metadata, RAM and CPU/device/FUSE state
└── snapshot.qcow2     # Standalone container disk, without a backing file
```

Paths and source identities are recorded inside the memory metadata; no binding
configuration or third artifact is required. Export publishes
through a private staging directory and atomic no-overwrite rename after syncing
both files and the directory. Keep the destination unchanged while export or
rollback is in flight. On invalidation or parent-sync failure, rollback quarantines
the name and removes only its verified directory and two members. A changed name,
member or layout is preserved; the error reports the last observed parent and any
quarantine residue. This ownership contract does not promise atomic conditional
unlink against arbitrary concurrent mutation by the same host user. No unsynced
publication is reported as success.

## Target paths and external files

The Rust API uses the same path-only flow as the CLI:

```rust
source.export_checkpoint("/srv/checkpoints/web").await?;
let restored = runtime.import_checkpoint(
    "/srv/checkpoints/web",
    CheckpointImportOptions { name: Some("web-copy".into()) },
).await?;
restored.resume().await?;
```

An internal `LocalCheckpointProvider` records the actual share roots and exact
readonly boot path used at VM start. Export discovers linked object paths from
capture descriptors, checks their identities, and saves root-relative locators.
It does not search the tree, copy shared files, retain orphan descriptors, or
require an inherited-FD configuration. `checkpoint inspect` reports the saved
local roots and boot path without opening those resources.

Import opens each saved path afresh. Handles receive independent open file
descriptions with their saved access/status flags; creation and truncation flags
are refused. Guest positions stay in saved guest memory, and saved FUSE directory
listings/cookies continue unchanged. Object kind, target share mount, hard-link aliases and handle/DAX access roles
are checked before restoration. V2 permits different source and target device/inode
identities; aliases must still identify the same target object. Path traversal,
intermediate symlink escape, linked-file disappearance and access errors fail import. These checks do not prove immutable content or detect every inode
reuse after all prior descriptors close; external writer coordination is required. A symlink object itself may be retained with `O_PATH` without
following its target.

New exports use **path binding metadata v2** inside the unchanged native version-9
pair. Saved `BoxOptions` retain their mounts. Import creates the new box’s internal
directories first, resolves already prepared directory volumes from those options,
and reopens each saved relative path under its target root. External data is never
copied and import starts no mount service. The local runtime’s existing unsupported
managed-volume and typed-mount restrictions still apply.

`BoxLiteShared` is rebuilt in the new box with the original guest container ID and
normal container/volume mount points. Removing the source box no longer removes a
v2 import’s internal shared root. A retained internal file or directory that cannot
be reconstructed from configuration/state fails import; no empty file is fabricated.
The VM-owned boot root retains its deterministic directory recipes.

Prepare external data to match the captured cut and coordinate all host writers;
importing memory does not roll external contents back. Do not run two restored guests
against the same writable roots concurrently. Relative locators do not discover
objects through another hard link if their saved names disappear.

V1 path metadata retains its original local behavior: exact source roots and object
device/inode identities are required, including the source `BoxLiteShared` tree.
REST import refuses v1 and asks you to re-export with a current runtime.

An external regular file already unlinked at capture cannot be reopened by path.
When it has no existing file DAX mapping, import omits its backend node/handles;
subsequent requests using those missing IDs return guest `EBADF`. A replacement at
its former name is never substituted. A legitimate linked filename ending in
` (deleted)` remains a normal linked file: inode link count determines deletion.
Missing directories, linked files, boot recipes and **existing file DAX mappings**
remain strict dependencies. Missing mapped backing rejects import; no empty file
or anonymous mapping is substituted.

Guest caching can satisfy a read or write without a backend request. A new DAX
mapping may also resolve a surviving inode independently of its former handle.
The `EBADF` guarantee applies to requests that reach a missing backend ID; the
focused guest test uses aligned direct I/O for an absent whole object and `fsync`
for an absent handle. Later exports preserve allocation counters and omit missing
backend records, so stale guest IDs cannot alias newly allocated objects.

The readonly guest boot disk is external. Import checks the saved boot path's full
length and digest, or uses an exact digest-matching entry in the importing runtime's
cache when that path is absent. It never rebuilds a substitute on cache miss.
The imported container disk is a private QCOW2 and stays private through resume,
stopped cold starts, disk snapshots and later checkpoints. Share roots and the
selected boot path persist across runtime restarts; a cold start creates a new guest
session and does not recover old orphan handles.

## Failure and compatibility

Import binds resources through SCM_RIGHTS after sandbox installation and before any
vCPU is released. It publishes only after the owner confirms Paused. Failure stops
and joins the new shim before removing attempt-owned storage; existing share roots,
mounts and original checkpoint files remain untouched.

Cancellation or an uncertain capture outcome stops the source owner and joins writers
before cleanup. A missing or corrupt shim identity file while its PID is live is an
uncertain join: attempt storage is retained, and the unverified PID receives no
signal. Exiting the launcher or queuing a cgroup kill alone does not prove that
descendant writers exited. Known export failures preserve Paused. Never blindly retry a control
operation whose outcome is unknown. Ordinary backend captures retain their documented
consistency limits and always resume/thaw after a known copy failure.

Older full checkpoints are refused with an explicit unsupported-version error and
left intact. No RAW container conversion or share extraction path is provided.
Provider-era version-9 checkpoints without automatic local-path metadata cannot be
imported through this API: import reports explicit incompatibility before provisioning
a box. Inspection still accepts their envelope and reports dependencies. Current
artifacts use a versioned local-path marker inside the unchanged native reference
triple; native descriptor transport is unchanged. A box started by an older runtime
must stop and restart before exporting through this API so its concrete paths are
recorded. Older runtimes do not provide this automatic path resolution.
Ordinary disk-only `.boxlite` archives retain their existing format and compatibility.
Checkpoint operations are available in Rust and the CLI for local runtimes and
independent `boxlite serve` servers advertising `checkpoints_enabled: true`.
A missing capability on an older server returns `Unsupported`; no local fallback runs.
Other language SDKs are unchanged.

## REST transfers and caller-local paths

The Rust signatures above are identical for `BoxliteRuntime::rest(...)`.
`export_checkpoint(directory)` captures on the server and downloads the pair into a
new **caller-local** directory. `import_checkpoint(directory, options)` uploads a
caller-local pair and creates a **remote Paused** box. Only its name can be overridden;
the remaining options come from the checkpoint. `checkpoint inspect` stays local.
The CLI uses its normal `--url`, environment and profile selection:

```sh
boxlite --url http://127.0.0.1:8080 pause --host-writers-stopped web
boxlite --url http://127.0.0.1:8080 checkpoint export web ./downloaded
boxlite --url http://127.0.0.1:8081 checkpoint import ./downloaded --name restored
boxlite --url http://127.0.0.1:8081 resume restored
```

| HTTP operation | Direction / result |
| --- | --- |
| `POST /v1/boxes/{id}/pause` with `{"host_writers_stopped": true}` | Pause on the server; 204 |
| `POST /v1/boxes/{id}/resume` | Explicit resume on the server; 204 |
| `POST /v1/boxes/{id}/checkpoint/export` | Download temporary tar+zstd containing only the pair |
| `POST /v1/boxes/checkpoint/import?name=restored` | Upload tar+zstd; 201 with the new box’s metadata |

Configured base URL and routing prefixes apply normally; discovery stays at the
unprefixed `/v1/config`. Authentication is unchanged. Transport uses temporary files
and bounded chunks rather than buffering the checkpoint in memory. Downloads validate
the complete pair and hashes in private staging before atomic no-overwrite publication.
Uploads finish and validate before VM restoration. Missing, duplicate, extra and
nonregular archive members fail; transfer temporaries are removed on failure.
The archive is temporary: the delivered directory still contains only two files.

Import is never retried automatically. A lost response can mean that the server
created the remote box; inspect the server before issuing another import. Accepted
server capture/restore jobs may finish after the client disconnects. Native
cancellation does not permit deleting storage while native capture/restore writers
are still running. Exact readonly boot disk contents must exist at the recorded path
or in the target runtime’s digest-matching cache; a missing dependency is reported
rather than rebuilt.

## Focused REST verification

On a Linux x86_64 KVM host with the actual runtime and shim built, run one exact
acceptance case and keep its process logs:

```sh
make runtime:debug
BOXLITE_CHECKPOINT_LOGS=/tmp/checkpoint-rest-logs \
  make test:checkpoint:rest:acceptance SETUP_DONE=1 \
  FILTER=checkpoint_rest_preserves_process_across_independent_homes
```

The case uses independent runtime homes, prepares target volumes and exact boot
bytes, removes source dependencies, and transfers the pair over HTTP. It checks
Paused import, explicit resume, original PID/marker/execution ID, guest file access,
repeated export/import, cold start, bwrap and the VMM seccomp filter on every shim
thread. The log directory also retains both `serve` processes’ stderr.
