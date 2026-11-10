# Guest runtime

The Linux guest agent receives volume instructions through the guest initialization RPC. `storage::mount_volumes` dispatches legacy volumes and mounts aggregate exports through one virtio-fs root, then binds each export at its resolved guest destination. The planner mounts aggregate roots first, then orders every destination by depth, including legacy shares and block devices. A parent binding therefore cannot hide a nested mount just created by the same batch. Its guard owns all successful mounts in the batch and rolls them back in reverse order if mounting or later initialization fails; `commit` preserves them after initialization succeeds. Before a block mount returns successfully to that batch, its helper owns cleanup: a resize or other post-mount initialization error unmounts the device and reports any cleanup failure alongside the original error.

The same guest agent bootstraps itself as native PID 1 or as a child of libkrun's init, with shared container and RPC behavior.

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

Native Box readiness still needs VMM device integration.
With the current kernel, vsock can bind `CID_ANY` without a device; the ready notification fails to connect and the host times out.
This is separate from fatal startup errors, which reset PID 1.
Linux x86_64 results do not qualify macOS or arm64.

## Native VMM mount acceptance

`make test:integration:vmm:mounts` boots a separate guest artifact on KVM with the real Linux virtio-fs driver. The target builds the agent with the non-default `integration-test-init` feature in `target/vmm/guest-mount`, then supplies it to the VMM harness as `VMM_GUEST_MOUNT_INIT`. This feature selects an initramfs PID 1 acceptance driver; never distribute that artifact as the normal guest agent. Cargo unit tests retain their usual test entry point even with all features enabled.

The driver calls the same `storage::mount_volumes` as the initialization RPC. It checks SHARED and nested directory, writable single-file and read-only single-file exports with colliding filenames. It reads through resolved guest paths, requires EROFS on read-only write-open, writes and syncs writable files, and verifies rollback after both a partial mount failure and dropping an uncommitted initialization guard. It then remounts and commits successfully. The host harness checks write-through to the original hardlinked file and snapshot isolation. A successful guest prints `GUEST-MOUNTS-OK` and reboots; an error or panic must fail host acceptance.

This test establishes the guest mount adapter and native device working together. Production runtime startup still uses legacy per-tag guest instructions: a native runtime engine adapter, container target binding, copy RPCs and full Box lifecycle acceptance remain separate integration work.

The acceptance init lives in `tests/support/mount_init.rs` and is included only
with `integration-test-init`. It is not a standalone Cargo integration test.
