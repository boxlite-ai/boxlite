# Two-file checkpoints with disk-only coexistence

## TL;DR

Replace embedded disk/share archives with a checked memory image, a standalone QCOW2 container disk, and automatically recorded local paths. One operation reservation protects lifecycle and storage across processes; imported boxes appear Paused and resume only on request.

2026-10-28 · Local path design reviewed by the coordinator against BoxLite `ef55b160` and bundled libkrun `04cd88a8`. Implementation and focused path-only unit, CLI and real-KVM verification pass; historical provider-based evidence below is separate from this revised contract.

## Scope and observable behavior

Remove Rust/Node `checkpoint_enabled` and CLI `--enable-checkpoint`. Select checkpoint owner mode automatically for supported Linux x86_64/KVM configurations; retain ordinary starts and disk operations elsewhere. Persist actual mode/protocol before reporting start success; never retry through another mode. Reconnection uses that record; legacy option decoding only identifies old live mode. Old shims require explicit restart for new operations.

| Authoritative state | Disk snapshot / clone / export | Full checkpoint | Disk restore |
| --- | --- | --- | --- |
| Running | Capture internally; return Running | Reject | Reject |
| Paused | Reject before staging or mutation | Save; remain Paused | Reject |
| Stopped | Allow | Reject | Allow |
| Configured / Stopping / Failed / Unknown | Reject | Reject | Reject |

Import creates a new Paused box. Conflicting operations return Busy. Internal disk capture never publishes user Paused. Checkpoint export never starts or pauses a box. Caller coordinates existing external paths while the guest and host writers remain stopped. No share traversal, content archival, new cloud service, SDK checkpoint endpoint, or REST checkpoint API.

## Related work and lessons

| Original evidence | Observation and local decision |
| --- | --- |
| libkrun `ram_snapshot/full.rs:3–15,30–31,56–72` | Version 8 embeds RAW disks and share archives; version 7 is upgraded. Replace this format rather than wrapping it or adding another conversion path. Retain CPU/KVM/device validators. |
| libkrun `passthrough/snapshot.rs:113–166,755–865`; `passthrough/dax.rs:62–109` | FUSE session state already separates from object FDs. Reuse node IDs, lookup counts, handle flags, directory listings and inode projection; serialize anonymous DAX pages, but only references for file mappings. |
| [virtiofsd MigrationMode](https://virtio-fs.gitlab.io/virtiofsd/doc/virtiofsd/passthrough/enum.MigrationMode.html#variants) | Its FindPaths mode may search a whole share; FileHandles avoids that. Reject tree discovery here; capture descriptors reveal concrete paths that are verified before saving. |
| [Linux open_by_handle_at, description](https://man7.org/linux/man-pages/man2/open_by_handle_at.2.html#DESCRIPTION) | Requires `CAP_DAC_READ_SEARCH`; reject it as the default binding mechanism. Fresh local path opens avoid privileged inode handles. |
| [Linux unix, ancillary messages](https://man7.org/linux/man-pages/man7/unix.7.html#DESCRIPTION); [Landlock, FD rights](https://docs.kernel.org/userspace-api/landlock.html#rights-associated-with-file-descriptors) | SCM_RIGHTS duplicates open descriptions, can truncate, and has FD limits. Pre-open required access outside the shim; receive bounded batches and validate every descriptor. Landlock preserves passed-FD rights, but an O_PATH FD alone does not establish successful reopen. |
| [QEMU QCOW2, header and cluster mapping](https://qemu.readthedocs.io/en/master/interop/qcow2.html#header); BoxLite `disk/qcow2.rs:253,435–470,1336` | Existing flatten produces QCOW2 v3 without backing and does not sync; compressed clusters are unsupported. Reuse flatten with validated supported input features, an exclusively owned destination, and caller-owned sync. No RAW output. |
| [Linux flock](https://man7.org/linux/man-pages/man2/flock.2.html#DESCRIPTION), [rename flags](https://man7.org/linux/man-pages/man2/rename.2.html#DESCRIPTION), [fsync](https://man7.org/linux/man-pages/man2/fsync.2.html#DESCRIPTION) | Use independently opened lock descriptions, no-replace directory rename, and file plus directory sync. Plain rename may overwrite; file fsync alone does not persist names. |

Paths beginning `ram_snapshot/` are under bundled libkrun `src/vmm/src/`; `passthrough/` is under its `src/devices/src/virtio/fs/linux/`. Existing single-file checkpoints cannot satisfy this contract unchanged.

## How it works

### Pair format and verification

The published directory contains exactly `snapshot.mem` and `snapshot.qcow2`. Use full-image version **9**, with the existing eight-byte `KRUNVM\0\0` magic and a new fixed 160-byte little-endian header:

| Offset | Field |
| --- | --- |
| 0 / 8 / 12 | Magic / u32 version 9 / u32 header length 160 |
| 16 / 24 / 32 / 40 | u64 total memory-file length / metadata length / payload length / QCOW2 physical length |
| 48 / 80 / 112 | SHA-256 of metadata / payload / entire QCOW2 file |
| 144 | Sixteen reserved zero bytes |

Bound metadata to 16 MiB. Metadata records application schema version 1 (BoxLite options, guest/execution identity, image config, network policy), CPU/KVM compatibility, ordered device/queue layout, RAM regions, external dependencies and payload extents. Payload holds RAM, init.krun bytes and anonymous DAX pages; CPU/KVM/device/FUSE state resides in metadata. Require exact total length, checked arithmetic, nonoverlapping complete extents, supported versions/features, and matching hashes before allocating VM resources. Reject unknown required sections. Header lengths must agree with actual metadata/payload lengths; a checksum is integrity detection, not authenticity.

Disk descriptors distinguish `container_qcow2` from `external_readonly_boot`: retain capacity, device ID, image identity, cache/features, transport and queue state. The boot descriptor also records full-content SHA-256 and byte length. No disk segment lives in `.mem`. Delete version-7 upgrade, RAW copying/extraction and forced-RAW restore. Old full images/BoxCheckpoint v1 archives report an explicit unsupported-version error without modifying their inputs. Disk-only `.boxlite` keeps its existing wire format.

### Provider contract and object identity

Public Rust operations are `export_checkpoint(dir)`, `import_checkpoint(dir, options)` and read-only `inspect_checkpoint(dir)`. The CLI needs no binding file. Inspection verifies the memory envelope and reports local roots, boot path and expected QCOW2 digest without provisioning.

The stateless internal `LocalCheckpointProvider` records concrete share roots and the exact readonly boot backend from the VM specification in persisted state at start. This supports export through another process without reconstructing runtime caches. Export reads linked-object locators from capture FDs, validates a fresh safe open against their source identities, then drops those descriptors. Local application metadata has schema version 1; the native `(resource_id, recovery_point, object_key)` triple carries a `local-path-v1` marker, source device/inode identity and relative path. Native ABI and SCM_RIGHTS transport remain unchanged.

Import requires saved local metadata and checks root/object identities, mount, kind and cross-share aliases. Each saved handle and DAX role gets a fresh open description with its saved flags. Reject creation/truncation flags before opening; component-wise `openat` with pinned directories prevents intermediate symlink escape. Final symlink objects may use `O_PATH|O_NOFOLLOW`. Linux [open(2), DESCRIPTION and O_PATH](https://man7.org/linux/man-pages/man2/open.2.html) distinguishes independent descriptions from descriptor duplicates; [proc_pid_fd(5), DESCRIPTION](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html) supports locator discovery, not durable FD-number references. Guest positions remain in RAM and directory cookies/listings in FUSE state.

An external regular object already unlinked at capture has no reusable path. Omit it and its handle descriptions only when it has no existing file DAX mapping; native remapping preserves allocation counters and stale backend IDs return EBADF. Never open the old filename, even if reused. Link count, not a ` (deleted)` suffix, proves unlink eligibility. Cached guest I/O can avoid backend requests; new DAX setup may resolve a surviving inode independently of a handle. Existing missing DAX backing remains an import error, not an export-time policy change.

Cached directory listings preserve names, guest inode numbers, types, order and cookies independently of retained objects. Attach and validate an object index only where a listed entry corresponds to a retained node/handle/DAX object. Listing-only entries, including stale names and `.`/`..`, require no object FD; reserve their saved guest inode numbers without recovering nonexistent objects or binding outside the share. For surviving listing-only names, resolve only that saved name relative to its bound directory to restore the inode projection; reserve a vanished name's number without a host identity. A later lookup/readdirplus still observes the current binding, including replacement objects. Never walk the tree or retain an object solely to satisfy cached metadata.

Local paths must remain present and coordinated for the checkpoint/import lifetimes. No retention service, copied recovery tree, public provider traits, leases or inherited-FD configuration remain. Source box removal can delete `BoxLiteShared` and invalidate imports; stopping it preserves paths. Moving/replacing an object invalidates its concrete locator; no alias search is promised.

`BoxLiteShared` remains an ordinary required external root. VM-owned boot directories keep their deterministic recipe reconstruction. The readonly ext4 boot disk uses the recorded source path or an exact digest-matching runtime cache entry, with length/hash verification and persistent base pinning. Private imported QCOW2 plus concrete shared/volume/boot paths survive runtime restart and stopped cold starts.

Provider-era artifacts lacking automatic metadata fail import explicitly before provisioning, while inspection stays compatible. No native version/frame change is required; older clients cannot automatically resolve new local references. Ordinary disk archive compatibility is unchanged.

### Descriptor transport and sandbox

Add protocol generation 2 capability negotiation to the existing control socket; retain generation-1 state/stop reads. Missing capabilities require restart. A random operation ID identifies a dedicated Unix stream. Length/count headers precede metadata frames (16 MiB total); SCM_RIGHTS batches carry at most 64 FDs indexed by `(operation, share, object, role)`. Use `recvmsg(MSG_CMSG_CLOEXEC)`, never buffered reads that discard ancillary data. Validate counts, sequence, type/access, peer identity and operation; close all received FDs on truncation or mismatch. ACK each batch. Preflight the complete required FD count against RLIMIT_NOFILE with control/worker headroom.

Resource roles also include the host-created writable `.mem` FD and import's read-only `.mem`/boot-disk FDs. Add descriptor-based libkrun capture/import C ABI calls; no live sandbox needs to resolve an arbitrary checkpoint destination. Box-owned QCOW2 paths are already inside its storage allowlist. Derive memory-file and FD limits from selected mode, RAM, metadata and anonymous DAX bounds; remove archive-content allowances.

Prepare roots before spawn and include their existing bwrap path permissions. The default Linux sandbox is bwrap with production seccomp; Landlock is not installed before bwrap mounts. Test any additional post-mount Landlock domain separately. Transfer objects after the shim installs its default sandbox and before restoration releases any vCPU. Reuse `RestoredObject` for inode identity; extend restore inputs with independently pre-opened FDs for each saved handle and each file DAX access role. The adapter opens concrete paths before transfer, within the normal host permissions. Validate these FDs against the same object table, flags and access before consuming them. Preserve normal share-path rules for future filesystem requests; no sandbox disable, privileged handle reopen, or post-resume binding stage.

### Reservation, capture and publication

One operation guard replaces separate disk/checkpoint mutex policy. Acquire nonblocking flock on a stable per-box lock file, separate from VM-lifetime locks (independent open; never unlink/recycle), refresh state, then check the matrix. Precreate it during provisioning; operations only open it, so refusal creates nothing. Legacy missing-lock records require explicit stopped migration/restart. Start/resume/pause/stop/remove, disk restore and capture participate. Lock order: file lock → refreshed state → shim session; no DB/state lock spans I/O.

`BeginCapture(kind)` atomically checks live owner state and reserves its operation ID through binding/copy/publication; competing mutations return Busy. Emergency stop invalidates the session and joins writers; copy loops observe an abort flag, avoiding a stop queued behind a long export. If owner shutdown fails, terminate/join the shim before cleanup. A connected session survives host-lock loss; EOF, cancellation or unknown outcome stops it. Never retry blindly. Normal completion rechecks the token after publication; invalidation requires unpublishing the attempt's pair. Known failures restore the original state: Paused for checkpoint, Running for disk capture. Queries expose logical Running plus in-flight capture.

Running capture reuses vCPU acknowledgement, device drain, disk/share/DAX sync and IRQ draining (`ram_snapshot/lifecycle.rs:105–167,231–269`; `blk/mod.rs:269–301`; `passthrough/snapshot.rs:619`). Flatten the frozen chain into a private QCOW2 without replacing live sources. Ordinary platforms retain their guest freeze/process pause bracket with the same guard/matrix, hidden internal pause, and guaranteed resume/thaw. Their disk consistency retains existing backend limits.

Snapshot stores the copy; batch clone creates separate children of one captured base after resume; export compresses after resume. Import copies/reflinks into box-owned `disks/disk.qcow2`, never hard-links writable storage. Libkrun opens QCOW2 and restores capacity/identity/features/queues; later cold starts and captures use it. Existing chains may end in cached ext4; no new RAW intermediate is created.

For checkpoint export, reserve first, create a mode-0700 sibling staging directory, flatten its QCOW2, resolve and verify concrete local references, and let libkrun write the version-9 memory image using the verified disk digest and BoxLite metadata. Fsync both files and staging directory, then `renameat2(RENAME_NOREPLACE)` and fsync parent. Unsupported no-replace filesystems fail explicitly. Cleanup compares attempt-owned identities and never removes replacement names. A post-rename sync error is reported as durability uncertainty; remove only this attempt's still-identical publication where possible and report any residue. No success is claimed for an unsynced publication.

Import order is inspect → open and validate saved local paths → verify pair and dependencies → private box-owned QCOW2 → sandbox/FD transfer → devices/FUSE/DAX restore → owner confirms Paused → publish box. New host sockets/box ID coexist with saved guest identity. Failure/cancellation stops and joins the new shim before deleting attempt-owned disk/home; it never deletes existing mounts and roots or original artifacts. Persist selected paths in box state and the boot pin in `RestoredStorage` for cold starts.

## Implementation slices and ownership

Each row is a sequential review slice; split again before exceeding 400 added code lines, targeting 100–200 (embedded unit tests count). No two workers edit the same module concurrently. Each slice updates the behavior/maintenance docs beside its code.

| Slice | Sole module owner / dependency | Decisive check |
| --- | --- | --- |
| 1 | libkrun full-format codec / this review | Header bounds, digest corruption, v7/v8 rejection; no VM |
| 2 | libkrun FUSE dependency table / 1 | Existing session/alias/cursor validation without archive payload; partial readdir, delete an unretained later entry, export/import, then continue the saved cursor (including `.`/`..`) without an FD for the deleted name; surviving listed names retain inode projection |
| 3 | libkrun supplied-handle/DAX restore / 2 | Rootless SCM_RIGHTS orphan and writable DAX round trip under sandbox |
| 4 | libkrun QCOW2/external boot restore / 1 | Disk identity/capacity/features and bad-binding refusal |
| 5 | libkrun owner/C ABI + Rust FFI / 2–4 | Reserved session, stale token, disconnect/stop; ABI checks |
| 6 | BoxLite protocol/client/server / 5 | Framing, capability/version refusal, truncation, FD exhaustion/cleanup |
| 7 | BoxLite operation guard/state / 6 | Two real client processes race capture/resume/start/restore |
| 8 | BoxLite disk capture/snapshot/base manager / 7 | Live disk inode stays unchanged; batch base copied once |
| 9 | BoxLite internal local path adapter / 2,6 | Saved aliases/orphans, confined locators, missing path |
| 10 | BoxLite pair export/publication / 8,9 | Exact two files, no backing, disk-full/cancel/no-overwrite |
| 11 | BoxLite import/storage/boot references / 4,6,9,10 | Paused publication, original untouched, lifetime pin and failure cleanup |
| 12 | Capability selection/start-mode/lifecycle / 7,8,11 | Supported/ordinary/legacy running modes; no fallback |
| 13 | Rust/Node options + CLI consumers / 9,12 | Remove creation switches; config/inspection parsing; REST unchanged |
| 14 | Acceptance fixtures/guides / 10–13 | Full matrix, continued PID/marker/counter/execution, alternate both capabilities |

## Validation and remaining gates

Use `make test:unit:rust FILTER=checkpoint_local_paths`, `make test:unit:cli FILTER=checkpoint`, `make test:checkpoint:acceptance:build` and exact acceptance filters for this change. `make runtime:debug` builds the real runtime; `make fmt:check:rust` checks formatting. Local macOS execution is not KVM evidence.

For the current path-only contract, run only focused make filters on the authorized Linux/KVM host with the existing cache, real bwrap/seccomp and no stubs. Cover fresh independent flags/positions, confined locators, source identity/replacement, aliases, actual guest orphan EBADF, strict missing mapped backing, same process continuation, repeat export/import and persisted cold-start roots. Record actual commands, exits and source hashes; no broad suites, production rollback or red-green cycle is authorized.

Historical explicit-provider KVM runs on 2026-10-28 proved source-destruction recovery through copied roots/retained FDs. That contract is superseded and does not qualify the new path-only API. The provider callback used to inject cancellation after Prepare was removed with that API; this former injection coverage is retired. Current focused real-KVM verification passes actual guest orphan EBADF, independent flags and sequential positions, live DAX/linked-file I/O, missing mapped-path rejection, repeat export/import and cold start after a new runtime instance. Paths remain available throughout; this does not restore the retired source-destruction or provider-callback injection coverage.

Mapped RAM includes the copied kernel and low boot regions and may exceed configured memory MiB. Import checks CPU count exactly and requires the validated mapped regions to cover the logical memory setting; cold start retains that setting. Enabled-jailer FD defaults use three bounded descriptor sets plus control/disk headroom, preserving explicit numeric caps. These consumer rules match actual producer layout and overlapping descriptor ownership without changing the producer ABI.
