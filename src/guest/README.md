# Guest runtime

The Linux guest agent receives volume instructions through the guest initialization RPC. `storage::mount_volumes` dispatches legacy volumes and mounts aggregate exports through one virtio-fs root, then binds each export at its resolved guest destination. Its guard rolls back aggregate mounts if mounting or later initialization fails; `commit` preserves them after initialization succeeds.

## Native VMM mount acceptance

`make test:integration:vmm:mounts` boots a separate guest artifact on KVM with the real Linux virtio-fs driver. The target builds the agent with the non-default `integration-test-init` feature in `target/vmm/guest-mount`, then supplies it to the VMM harness as `VMM_GUEST_MOUNT_INIT`. This feature selects an initramfs PID 1 acceptance driver; never distribute that artifact as the normal guest agent. Cargo unit tests retain their usual test entry point even with all features enabled.

The driver calls the same `storage::mount_volumes` as the initialization RPC. It checks SHARED and nested directory, writable single-file and read-only single-file exports with colliding filenames. It reads through resolved guest paths, requires EROFS on read-only write-open, writes and syncs writable files, and verifies rollback after both a partial mount failure and dropping an uncommitted initialization guard. It then remounts and commits successfully. The host harness checks write-through to the original hardlinked file and snapshot isolation. A successful guest prints `GUEST-MOUNTS-OK` and reboots; an error or panic must fail host acceptance.

This test establishes the guest mount adapter and native device working together. Production runtime startup still uses legacy per-tag guest instructions: a native runtime engine adapter, container target binding, copy RPCs and full Box lifecycle acceptance remain separate integration work.
