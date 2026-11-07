## TL;DR

The same guest agent boots as native PID 1 or as a child of libkrun's init, with shared container and RPC behavior.

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

The native suite boots the actual agent on an ext4 root and in an initramfs.
A test-only child checks mount reuse, writable paths, hostname, limits, zygote inheritance, localhost TCP and Unix RPC.
Separate boots check argument errors and incorrect filesystem types; namespace tests check panic and child exit policies.
Host namespace and shutdown unit tests deny global `sync` with a test-only seccomp filter; KVM boots exercise the unfiltered sync/reset path.
The probe is an explicitly built Cargo example and is excluded from runtime artifacts.

Native Box readiness still needs VMM device integration.
With the current kernel, vsock can bind `CID_ANY` without a device; the ready notification fails to connect and the host times out.
This is separate from fatal startup errors, which reset PID 1.
Linux x86_64 results do not qualify macOS or arm64.
