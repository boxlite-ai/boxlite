# Two-file checkpoints with disk-only coexistence

## TL;DR

Replace embedded disk/share archives with a checked memory image, a standalone QCOW2 container disk, and explicit external bindings. One operation reservation protects lifecycle and storage across processes; imported boxes appear Paused and resume only on request.

2026-10-28 · Design/research review approved; implementation integrated. Real version-9 KVM continuation, source destruction, alternating disk/checkpoint capture and cold start are verified with the default sandbox and seccomp. Source baseline: BoxLite `31d8ee5d`, bundled libkrun `96c0ca3c`.

## Scope and observable behavior

Remove Rust/Node `checkpoint_enabled` and CLI `--enable-checkpoint`. Select checkpoint owner mode automatically for supported Linux x86_64/KVM configurations; retain ordinary starts and disk operations elsewhere. Persist actual mode/protocol before reporting start success; never retry through another mode. Reconnection uses that record; legacy option decoding only identifies old live mode. Old shims require explicit restart for new operations.

| Authoritative state | Disk snapshot / clone / export | Full checkpoint | Disk restore |
| --- | --- | --- | --- |
| Running | Capture internally; return Running | Reject | Reject |
| Paused | Reject before staging or mutation | Save; remain Paused | Reject |
| Stopped | Allow | Reject | Allow |
| Configured / Stopping / Failed / Unknown | Reject | Reject | Reject |

Import creates a new Paused box. Conflicting operations return Busy. Internal disk capture never publishes user Paused. Checkpoint export never starts or pauses a box. Caller coordinates external storage recovery points while the guest and host writers remain stopped. No share traversal, content archival, new cloud service, SDK checkpoint endpoint, or REST checkpoint API.

## Related work and lessons

| Original evidence | Observation and local decision |
| --- | --- |
| libkrun `ram_snapshot/full.rs:3–15,30–31,56–72` | Version 8 embeds RAW disks and share archives; version 7 is upgraded. Replace this format rather than wrapping it or adding another conversion path. Retain CPU/KVM/device validators. |
| libkrun `passthrough/snapshot.rs:113–166,755–865`; `passthrough/dax.rs:62–109` | FUSE session state already separates from object FDs. Reuse node IDs, lookup counts, handle flags, directory listings and inode projection; serialize anonymous DAX pages, but only references for file mappings. |
| [virtiofsd MigrationMode](https://virtio-fs.gitlab.io/virtiofsd/doc/virtiofsd/passthrough/enum.MigrationMode.html#variants) | Its FindPaths mode may search a whole share; FileHandles avoids that. Reject tree discovery here; provider keys identify objects. |
| [Linux open_by_handle_at, description](https://man7.org/linux/man-pages/man2/open_by_handle_at.2.html#DESCRIPTION) | Requires `CAP_DAC_READ_SEARCH`; reject it as the default binding mechanism. Caller-owned descriptors support unprivileged providers. |
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

Public Rust operations become `export_checkpoint(dir, &dyn CheckpointExportProvider)`, `import_checkpoint(dir, options, &dyn CheckpointImportProvider)`, plus read-only `inspect_checkpoint(dir) -> CheckpointDependencies`. Inspection parses `.mem`, lists required bindings and the expected QCOW2 digest; import subsequently verifies the pair. Inspection never opens shares, boots, or provisions a box.

Export provider `prepare(request)` receives BoxLite-owned share/object IDs, kind/access/projection summaries and duplicated FDs. It associates caller-coordinated storage cuts with stable references. Provider retention must survive source destruction for the caller-defined checkpoint lifetime; a temporary FD is not durable retention. Import provider `bind(dependencies)` supplies roots, FDs and leases; private translation constructs `RestoredObject` values. Cancellation drops attempt-owned resources; recovery points remain caller-owned.

A serialized reference is `(resource_id, recovery_point, object_key)`, never a host path or `(dev, ino)` identity. Providers map source identity across shares to the same recovered inode where aliases overlap; distinct objects cannot collapse. Verify supplied aliases, file kinds, guest inode/ctime projection, expected root, and mount consistency before restore. Object bindings retain saved indices, with nullable slots only for regular files recorded as unlinked at capture. Aliases must agree about presence. Linked files, roots, boot recipes and existing DAX mappings remain strict dependencies.

For an eligible absent object, remove its nodes/handles from a cloned session before existing backend restoration; an omitted eligible handle alone removes only that handle. Compact live object indices and remap node/handle/DAX/listing references, clearing an absent listing object's projection binding while keeping its name/cookie/inode. Validate original metadata before normalization and all present roles afterward; never discard a bad supplied binding as missing. Preserve allocation counters: stale guest IDs remain absent and ordinary backend requests return EBADF, including release; forget has nothing to release. Later captures naturally omit missing backend records. Cached guest reads/writeback may succeed without a backend request. Missing DAX backing or roles reject import before VM allocation; no fake file, anonymous zero replacement or unsafe KVM mapping is allowed.

Cached directory listings preserve names, guest inode numbers, types, order and cookies independently of retained objects. Attach and validate an object index only where a listed entry corresponds to a retained node/handle/DAX object. Listing-only entries, including stale names and `.`/`..`, require no object FD; reserve their saved guest inode numbers without recovering nonexistent objects or binding outside the share. For surviving listing-only names, resolve only that saved name relative to its bound directory to restore the inode projection; reserve a vanished name's number without a host identity. A later lookup/readdirplus still observes the current binding, including replacement objects. Never walk the tree or retain an object solely to satisfy cached metadata.

The local adapter accepts an explicit binding config mapping resource IDs to recovery-point IDs, roots and object-key locators. Paths are caller-provided relative locators, opened beneath a pinned root without symlink escape; there is no search. Available unlinked objects require caller-supplied open FDs; the CLI config can name inherited FD numbers, duplicated before use. For saved eligible orphans, an omitted object key or EBADF from duplicating a nonnegative FD expresses absence; a missing handle description is independently eligible. Configured path failures and all other binding/provider errors remain strict. A missing primary object cannot validate a still-supplied handle: omit its object key and roles together. The library supplies no background retention service.

Omitted `unlinked` metadata defaults to false and false is not serialized. Complete old v9 bindings remain accepted, but images without unlink proof cannot tolerate missing objects/handles. Older strict readers reject new true-unlinked metadata or null indices. This changes Rust BoundShare object slots to Option<File>; the descriptor transport still transfers real FDs only and consumes each received index exactly once. Ordinary cold starts use retained roots with a fresh guest/session and need no old orphan handles.

`BoxLiteShared` is an ordinary required external binding. A runtime-owned boot root is a separate deterministic recipe: empty root, known init.krun projection and known runtime-created directories. Validate every captured reference against this whitelist; reject extra objects rather than archiving them. Init bytes remain in memory payload. The read-only ext4 boot disk is supplied from the runtime cache or provider, verified by full digest and retained through a persistent base reference for the box lifetime. Never rebuild a substitute on cache miss; its ext4 format is unrelated to container conversion.

### Descriptor transport and sandbox

Add protocol generation 2 capability negotiation to the existing control socket; retain generation-1 state/stop reads. Missing capabilities require restart. A random operation ID identifies a dedicated Unix stream. Length/count headers precede metadata frames (16 MiB total); SCM_RIGHTS batches carry at most 64 FDs indexed by `(operation, share, object, role)`. Use `recvmsg(MSG_CMSG_CLOEXEC)`, never buffered reads that discard ancillary data. Validate counts, sequence, type/access, peer identity and operation; close all received FDs on truncation or mismatch. ACK each batch. Preflight the complete required FD count against RLIMIT_NOFILE with control/worker headroom.

Resource roles also include the host-created writable `.mem` FD and import's read-only `.mem`/boot-disk FDs. Add descriptor-based libkrun capture/import C ABI calls; no live sandbox needs to resolve an arbitrary checkpoint destination. Box-owned QCOW2 paths are already inside its storage allowlist. Derive memory-file and FD limits from selected mode, RAM, metadata and anonymous DAX bounds; remove archive-content allowances.

Prepare roots before spawn and include their existing bwrap path permissions. The default Linux sandbox is bwrap with production seccomp; Landlock is not installed before bwrap mounts. Test any additional post-mount Landlock domain separately. Transfer objects after the shim installs its default sandbox and before restoration releases any vCPU. Reuse `RestoredObject` for inode identity; extend restore inputs with independently pre-opened FDs for each saved handle and each file DAX access role. This avoids assuming `/proc/self/fd` reopen of a retained orphan is permitted by Landlock. Validate these FDs against the same object table, flags and access before consuming them. Preserve normal share-path rules for future filesystem requests; no sandbox disable, privileged handle reopen, or post-resume binding stage.

### Reservation, capture and publication

One operation guard replaces separate disk/checkpoint mutex policy. Acquire nonblocking flock on a stable per-box lock file, separate from VM-lifetime locks (independent open; never unlink/recycle), refresh state, then check the matrix. Precreate it during provisioning; operations only open it, so refusal creates nothing. Legacy missing-lock records require explicit stopped migration/restart. Start/resume/pause/stop/remove, disk restore and capture participate. Lock order: file lock → refreshed state → shim session; no DB/state lock spans I/O.

`BeginCapture(kind)` atomically checks live owner state and reserves its operation ID through binding/copy/publication; competing mutations return Busy. Emergency stop invalidates the session and joins writers; copy loops observe an abort flag, avoiding a stop queued behind a long export. If owner shutdown fails, terminate/join the shim before cleanup. A connected session survives host-lock loss; EOF, cancellation or unknown outcome stops it. Never retry blindly. Normal completion rechecks the token after publication; invalidation requires unpublishing the attempt's pair. Known failures restore the original state: Paused for checkpoint, Running for disk capture. Queries expose logical Running plus in-flight capture.

Running capture reuses vCPU acknowledgement, device drain, disk/share/DAX sync and IRQ draining (`ram_snapshot/lifecycle.rs:105–167,231–269`; `blk/mod.rs:269–301`; `passthrough/snapshot.rs:619`). Flatten the frozen chain into a private QCOW2 without replacing live sources. Ordinary platforms retain their guest freeze/process pause bracket with the same guard/matrix, hidden internal pause, and guaranteed resume/thaw. Their disk consistency retains existing backend limits.

Snapshot stores the copy; batch clone creates separate children of one captured base after resume; export compresses after resume. Import copies/reflinks into box-owned `disks/disk.qcow2`, never hard-links writable storage. Libkrun opens QCOW2 and restores capacity/identity/features/queues; later cold starts and captures use it. Existing chains may end in cached ext4; no new RAW intermediate is created.

For checkpoint export, reserve first, create a mode-0700 sibling staging directory, flatten its QCOW2, obtain provider references, and let libkrun write the version-9 memory image using the verified disk digest and BoxLite metadata. Fsync both files and staging directory, then `renameat2(RENAME_NOREPLACE)` and fsync parent. Unsupported no-replace filesystems fail explicitly. Cleanup compares attempt-owned identities and never removes replacement names. A post-rename sync error is reported as durability uncertainty; remove only this attempt's still-identical publication where possible and report any residue. No success is claimed for an unsynced publication.

Import order is inspect → provider prepares recovery points/roots/FDs → verify pair and dependencies → private box-owned QCOW2 → sandbox/FD transfer → devices/FUSE/DAX restore → owner confirms Paused → publish box. New host sockets/box ID coexist with saved guest identity. Failure/cancellation stops and joins the new shim before deleting attempt-owned disk/home; it never deletes caller mounts, recovery points or original artifacts. Store restart bindings and boot pin in `RestoredStorage`; process-local FDs alone are insufficient for later cold starts.

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
| 9 | BoxLite provider/local adapter / 2,6 | Explicit aliases/orphans, confined locators, missing binding |
| 10 | BoxLite pair export/publication / 8,9 | Exact two files, no backing, disk-full/cancel/no-overwrite |
| 11 | BoxLite import/storage/boot references / 4,6,9,10 | Paused publication, original untouched, lifetime pin and failure cleanup |
| 12 | Capability selection/start-mode/lifecycle / 7,8,11 | Supported/ordinary/legacy running modes; no fallback |
| 13 | Rust/Node options + CLI consumers / 9,12 | Remove creation switches; config/inspection parsing; REST unchanged |
| 14 | Acceptance fixtures/guides / 10–13 | Full matrix, continued PID/marker/counter/execution, alternate both capabilities |

## Validation and remaining gates

Use `make test:unit:rust FILTER=checkpoint`, `make test:unit:cli`, `make test:integration:rust FILTER=snapshot`, `make fmt:check:rust` and relevant `make lint` checks. `make test:shim:linkage` builds and checks the real static shim and descriptor ABI. Bundled libkrun provides `make -C src/deps/libkrun-sys/vendor/libkrun snapshot-check`, `snapshot-test SNAPSHOT_FILTER=…`, `snapshot-capi-test`, `snapshot-abi-check` and `snapshot-feature-check`. Its default target is Linux x86_64; local macOS execution is not KVM evidence.

On the separately authorized Linux/KVM host: real `make runtime:debug`, `make test:checkpoint:acceptance:build`, `make test:snapshot:rootless`, and `make test:checkpoint:acceptance SETUP_DONE=1`, with `BOXLITE_DEPS_STUB` unset. Rootless coverage includes externally received orphan, handle and writable-DAX descriptors under default bwrap/seccomp, plus a bounded-tmpfs ENOSPC failure through the BoxLite copier. A separate post-mount Landlock domain is optional coverage; it is not the default sandbox and is not required to qualify that default. Assert same PID/random heap marker/counter/execution ID, directory cursor/hardlinks/orphan/DAX I/O, absent untouched share contents, source/import disk independence, and both capabilities alternating on default/imported boxes. Inject incomplete pair, digest mismatch, disk full, concurrent resume, cancel and disconnect.

Observed on 2026-10-28: the real runtime and acceptance build pass, and KVM acceptance continues the original PID, heap marker, counter and execution after destroying the source home and shares. It also verifies new network/exec work, all-thread seccomp on both shims, an imported disk snapshot followed by another checkpoint, private-disk independence, cancellation/disconnect stop and cold start from retained dependencies. Linux checkpoint tests pass publication rollback/sync uncertainty, replacement/no-overwrite, incomplete/digest failures, provider roles, operation conflicts and boot-pin GC. Rootless received-FD and real ENOSPC checks pass. Static-shim linkage remains a required build qualification command above.

The focused missing-orphan regression runs with `make test:checkpoint:acceptance SETUP_DONE=1 FILTER=checkpoint_missing_orphans_return_guest_ebadf` after rebuilding the real runtime. On the same authorized KVM host it passes with default bwrap/seccomp: missing whole-object guest reads/writes return `EBADF`, missing-handle `fsync` returns `EBADF`, and another handle, normal file and DAX mapping survive. After allocating new guest resources, another export/import continues the same process past the paused watermark with the stale descriptors still failing. Legacy metadata without unlink proof, negative supplied FDs and missing DAX roles remain rejected. DAX setup resolves a surviving inode independently of the handle, so even a new DAX mapping can allow reads/writes through a missing handle; the handle regression uses backend-reaching `fsync` explicitly.

Mapped RAM includes the copied kernel and low boot regions and may exceed configured memory MiB. Import checks CPU count exactly and requires the validated mapped regions to cover the logical memory setting; cold start retains that setting. Enabled-jailer FD defaults use three bounded descriptor sets plus control/disk headroom, preserving explicit numeric caps. These consumer rules match actual producer layout and overlapping descriptor ownership without changing the producer ABI.
