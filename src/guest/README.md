# Guest runtime

The Linux guest agent receives volume instructions through the guest initialization RPC. `storage::mount_volumes` dispatches legacy volumes and mounts aggregate exports through one virtio-fs root, then binds each export at its resolved guest destination. The planner mounts aggregate roots first, then orders every destination by depth, including legacy shares and block devices. A parent binding therefore cannot hide a nested mount just created by the same batch. Its guard owns all successful mounts in the batch and rolls them back in reverse order if mounting or later initialization fails; `commit` preserves them after initialization succeeds. Before a block mount returns successfully to that batch, its helper owns cleanup: a resize or other post-mount initialization error unmounts the device and reports any cleanup failure alongside the original error.

The same guest agent bootstraps itself as native PID 1 or as a child of libkrun's init, with shared container and RPC behavior.

## Clock recovery

On Linux/native Boxes, the shim attempts `Guest.SyncClock` at startup and checks host time every 2 seconds. It uses `CLOCK_BOOTTIME` for the 6-second gap and 60-second periodic triggers, and pushes when the wall clock's change differs from elapsed time by more than 100ms. A failed push stays due until the guest responds successfully. The shim owns the task, including after a detached Box's creator exits. libkrun retains its existing clock synchronization mechanism.

TCP and Unix listeners return `PermissionDenied` for `Guest.SyncClock`.

The host samples current UTC after connecting and immediately before sending. The agent accepts the call only from the host control plane (the vsock listener rejects non-host peers before tonic sees them), validates a post-epoch timestamp with a valid subsecond part, then reads `CLOCK_REALTIME`. Only an absolute difference greater than 100ms calls `clock_settime`, in either direction; a difference of exactly 100ms or less returns success without adjusting the clock. The host is the clock authority, so legitimate timestamps after long sleeps have no ahead-of-guest bound. Invalid timestamps, clock-read failures, and clock-setting failures propagate as gRPC errors; only successful responses update the shim's successful-push baseline. The 100ms threshold is a decision to adjust, not a precision guarantee: transport and scheduling delay remain uncompensated. The correction never touches the RTC or `CLOCK_MONOTONIC`, so the guest's own RTC offset and alarms survive it, and user containers need no additional `CAP_SYS_TIME`.

## Runtime directory delivery

`Container.Mount` has two source forms. A legacy `source` is one folder name
inside the container's shared volumes directory and requires `read_only=true`.
Aggregate delivery leaves `source` empty and supplies `device_tag`, a unique
`export_key` incarnation, an absolute `destination`, and the requested read-only
or writable bind mode. Initialization registers each aggregate root by device
tag. Installed initialization mounts already belong to the rollback guard when
root publication starts; failed publication unwinds them without replacing a
previous registration. Committing initialization keeps the roots available for
later RPCs.

Aggregate Mount and Detach require a container whose capability bounding set
excludes `CAP_SYS_ADMIN`. Aggregate Mount also requires that the target mount
namespace belong to the guest agent's user namespace. The agent rejects
unsupported targets before publishing a mount. Mount replay and Detach must
refer to the recorded namespace. If init has switched namespaces, the agent
reports a failed precondition and retains the record. Legacy share delivery is
read-only.

The agent clones the export with `open_tree`, applies recursive read-only flags
when requested, and moves the clone into the running container's mount namespace
with `move_mount`. It refuses destinations containing entries and walks every
component without following symlinks. Guest writable mode does not override the
host export's permission policy. A retry must match the incarnation's source,
mode, destination, and actual mounted tree.

A `BindMount` with a `record_key` on `Container.Init` is mounted by the container
runtime like any whole-directory bind. Once the container is created, before
init runs, the agent records that mount under the key: it resolves the
destination through init's `/proc/<pid>/root` the way the runtime did, keeps an
`O_PATH` descriptor on the mount point, and reads the mount ID. `Detach` then
handles it like an attached mount. A `BindMount` with `added` set was saved
while the box was stopped: its target must be empty and reached through no
symbolic link. Mounts apply in list order, as on Linux: a saved directory may
sit below an earlier mount and have later ones below it, but it must not
cover an earlier mount, and no later mount may cover it. Its owner is not
remapped. `Ping` advertises this with `records_boot_mounts`, which is set only
where the kernel identifies a mount namespace. A guest without it receives
the directories created with the box as plain binds.

Two recorded mounts that resolve to one mount, through an image link between
their destinations or two spellings of one target, fail `Container.Init`:
neither could be detached alone. `Detach` also refuses a recorded directory
that has one of the runtime's other mounts at or below it, files and volumes
included, because a lazy detach would take that mount along.

The incarnation record retains the original cloned-tree descriptor. This pins
the mounted tree rather than the directory underneath it, preventing mount-ID
reuse while the record is attached. The agent reads that tree's checked
`statx(STATX_MNT_ID)` identity before publishing it, because a mount keeps its ID
when it moves. Before retry success or detach, another child opens the destination
without following links and compares its mount ID with the retained tree. A
replacement at the original path leaves the old record intact while its mount
still exists. This ownership follows Linux's
[`open_detached_copy`, `do_move_mount`, and `dissolve_on_fput`](https://github.com/torvalds/linux/blob/v6.12/fs/namespace.c):
moving changes the mount's namespace, while the open file retains its reference.

`Container.Detach(container_id, destination, export_key)` uses `MNT_DETACH`.
New opens lose access through the destination; already-open files and directory
references remain usable. Runtime and OCI descendants must be detached first.
Removing a runtime overmount removes only its last bookkeeping entry, preserving
the underlying OCI entry. Repeated detach succeeds without another unmount;
detach of an unseen incarnation records a tombstone that rejects delayed Mount.
Detached records and tombstones stay for the agent's lifetime, so their count follows
the Detach requests the host has issued; each holds a key, a path, and two flags.
Mount and Detach hold the same per-container write lock through syscall execution
and bookkeeping, in an owned task that survives RPC caller cancellation.

Aggregate Mount checks that the kernel supports mount namespace IDs and the
`statmount` recovery query before publishing a mount. If the helper's final
report is lost, the agent returns an error and retains the mount identity and
destination. Detach verifies any still-present tree at its original path in
the recorded namespace. If an ancestor was renamed before Detach opened the
destination, restore the original path to retry.

After a lost detach report, the agent clears the record once `statmount`
confirms absence in the same namespace. If that query is unavailable or fails,
the record and destination remain reserved.

These are lower-level delivery operations. The caller coordinates guest
acknowledgment with host export retirement and reconciles unknown RPC outcomes.
They do not expose a public Box mount transaction API.

Run `make test:unit:guest FILTER=storage::attach::tests` for validation and
tombstone checks, and `make test:guest-perms` for the ignored `privileged_`
namespace cases: actual RO/RW delivery, replay, descendant refusal, lazy detach
with an open descriptor, and ancestor rename plus mount replacement. The guest
unit suite also covers root publication rollback and OCI bookkeeping.

## Startup ownership

| Responsibility | Native PID 1 | libkrun child |
| --- | --- | --- |
| System mounts, hostname, agent limits | Agent bootstrap | `init.krun` |
| Writable `/tmp`, `/var/tmp`, `/run` | Before the zygote fork | Existing async startup |
| Sysctl hardening and zygote | Before Tokio | Before Tokio |
| Reaper, loopback and RPC listener | Agent | Agent |
| Fatal startup error, help, or panic | Sync and restart | Conventional process exit |

Bootstrap mounts proc, devtmpfs, sysfs, cgroup2, devpts and `/dev/shm`, creates
`/dev/fd -> /proc/self/fd`, then makes root propagation shared.
Each container runs in its own cgroup, which holds the box CPU and memory limits. Non-privileged
containers see that cgroup read-only at `/sys/fs/cgroup` through a cgroup namespace
([resource limits guide](../../docs/guides/resource-limits.md#limits-visible-inside-the-container)).
New system mounts match the pinned `init.krun` flags and use its default filesystem options;
mount-point directories are created with mode `0755`, subject to umask.
Devpts uses the kernel's default slave and ptmx permissions; `/dev/shm` uses its default mode without `nodev`.
Existing mounts of the expected type are reused; a different type fails before it can be hidden by an overmount.
Mount IDs identify the visible mount, including bind mounts and stacked mounts.
Bootstrap uses `rustix` directly for `statx`, reusing the crate already included through `tempfile`.
Musl's libc bindings do not expose this call on every supported toolchain.

The root disk stays read-only; its staged directories provide mount points for writable runtime filesystems.
PID 1 uses `HOSTNAME`, defaulting to `localhost`, and matches libkrun's agent limits:
`NPROC=4096/8192` and `NOFILE=1048576/1048576` (soft/hard).
OCI workload limits remain independent.

Loopback comes up before the RPC listener, including when external networking is disabled.
The zygote resets its inherited panic hook before creating container PID namespaces, so a child panic cannot acquire the guest-init reset policy.
Failed fatal diagnostics do not abort the reset path; a rejected reset parks init for host cleanup.
Successful container exit and host-driven Shutdown keep their existing exit-record and RPC ordering.

## Native qualification

```sh
make vmm:boot:host
make test:integration:vmm:native
make test:unit:guest
```

The native target finishes runtime preparation before building the probe, including with `make -j`, so their libseccomp cache preparation cannot overlap.
`SETUP_DONE=1` reuses a runtime that has already been prepared.

Guest and probe paths default to `x86_64-unknown-linux-musl/debug/` under `CARGO_TARGET_DIR` (or `target/`); the probe lives in `examples/`.
Relative output directories resolve from the repository root; `VMM_GUEST` and `VMM_GUEST_PROBE` can override the individual paths.

Runtime preparation still uses its default layout.
For custom output directories, prepare that runtime first, supply the guest at its selected path, and run with `SETUP_DONE=1`.

The native suite boots the actual agent from a read-only ext4 root, without an initramfs.
A test-only launcher runs from that disk and execs the agent as PID 1.
Its child checks the ext4 root and rejected writes, mount reuse, writable paths, hostname, limits, zygote inheritance, localhost TCP and Unix RPC.
Fresh boot also checks libkrun-compatible mount flags, initial PTY permissions and mount-point creation under a permissive umask.
Separate boots check argument errors and incorrect filesystem types; namespace tests check panic and child exit policies.
Host namespace and shutdown unit tests deny global `sync` with a test-only seccomp filter; KVM boots exercise the unfiltered sync/reset path.
The probe is an explicitly built Cargo example and is excluded from runtime artifacts.

Native Box qualification requires a successful ready notification, start, exec
and shutdown over the attached vsock device. Native initialization uses the
aggregate virtio-fs device tag and logical export key; libkrun retains per-tag
mount instructions.
Linux x86_64 results do not qualify macOS or arm64.

## Native VMM mount acceptance

`make test:integration:vmm:mounts` boots a separate guest artifact on KVM with the real Linux virtio-fs driver. The target builds the agent with the non-default `integration-test-init` feature in `target/vmm/guest-mount`, then supplies it to the VMM harness as `VMM_GUEST_MOUNT_INIT`. This feature selects an initramfs PID 1 acceptance driver; never distribute that artifact as the normal guest agent. Cargo unit tests retain their usual test entry point even with all features enabled.

The driver calls the same `storage::mount_volumes` as the initialization RPC. It checks SHARED and nested directory, writable single-file and read-only single-file exports with colliding filenames. It reads through resolved guest paths, requires EROFS on read-only write-open, writes and syncs writable files, and verifies rollback after both a partial mount failure and dropping an uncommitted initialization guard. It then remounts and commits successfully. The host harness checks write-through to the original hardlinked file and snapshot isolation. A successful guest prints `GUEST-MOUNTS-OK` and reboots; an error or panic must fail host acceptance.

This test establishes the guest mount adapter and native device working together. The native runtime sends aggregate guest instructions; libkrun retains per-tag instructions. The [M2/M3 matrices](../../docs/guides/native-vmm.md#linux-x86_64-m2-and-m3-matrices) exercise container binding, copy RPCs, volumes and Box lifecycle separately from this mount-only acceptance test.

The acceptance init lives in `tests/support/mount_init.rs` and is included only
with `integration-test-init`. It is not a standalone Cargo integration test.
