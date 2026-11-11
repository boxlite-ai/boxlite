# Guest runtime

The Linux guest agent receives volume instructions through the guest initialization RPC. `storage::mount_volumes` dispatches legacy volumes and mounts aggregate exports through one virtio-fs root, then binds each export at its resolved guest destination. The planner mounts aggregate roots first, then orders every destination by depth, including legacy shares and block devices. A parent binding therefore cannot hide a nested mount just created by the same batch. Its guard owns all successful mounts in the batch and rolls them back in reverse order if mounting or later initialization fails; `commit` preserves them after initialization succeeds. Before a block mount returns successfully to that batch, its helper owns cleanup: a resize or other post-mount initialization error unmounts the device and reports any cleanup failure alongside the original error.

## Keyed execution startup

The additive `Execution.ExecKeyed` RPC requires internal metadata
`idempotency-key: <random-token>.<deadline-unix-ms>`. Normal `Exec` keeps its
existing behavior. The caller fixes a deadline at request acceptance, at most
24 hours ahead (one minute of clock skew is allowed). Unsupported guests reject
the separate RPC instead of silently ignoring retry identity.

The guest reserves the token before starting a command. Matching payloads share
one startup task and its result, including completed short commands; changed
payloads return `idempotency_mismatch`. Caller cancellation cannot cancel the
owned startup task after effects begin. Output retention and inventory eviction
do not remove this association.

Expired tokens fail before lookup. A monotonic elapsed-time floor preserves the
highest observed wall time, so forward jumps followed by clock rollback cannot
make reclaimed tokens valid again. New requests reclaim expired entries only
after startup has published its result, so a delayed old RPC cannot repeat the
command and unfinished tasks remain counted. The registry admits up to 4096
unexpired or unfinished requests and returns resource exhaustion at capacity.
VM termination loses these associations; callers must bind retries to a VM
generation and refuse to run uncertain work in a replacement VM.

`make test:unit:guest FILTER=keyed_execution` runs a real shell counter through
concurrent startup, mismatch and completed-execution retries.
`make test:unit:guest FILTER=service::exec::requests` checks expiry, delayed
tokens, cleanup and pending-capacity boundaries.

## Native VMM mount acceptance

`make test:integration:vmm:mounts` boots a separate guest artifact on KVM with the real Linux virtio-fs driver. The target builds the agent with the non-default `integration-test-init` feature in `target/vmm/guest-mount`, then supplies it to the VMM harness as `VMM_GUEST_MOUNT_INIT`. This feature selects an initramfs PID 1 acceptance driver; never distribute that artifact as the normal guest agent. Cargo unit tests retain their usual test entry point even with all features enabled.

The driver calls the same `storage::mount_volumes` as the initialization RPC. It checks SHARED and nested directory, writable single-file and read-only single-file exports with colliding filenames. It reads through resolved guest paths, requires EROFS on read-only write-open, writes and syncs writable files, and verifies rollback after both a partial mount failure and dropping an uncommitted initialization guard. It then remounts and commits successfully. The host harness checks write-through to the original hardlinked file and snapshot isolation. A successful guest prints `GUEST-MOUNTS-OK` and reboots; an error or panic must fail host acceptance.

This test establishes the guest mount adapter and native device working together. Production runtime startup still uses legacy per-tag guest instructions: a native runtime engine adapter, container target binding, copy RPCs and full Box lifecycle acceptance remain separate integration work.

The acceptance init lives in `tests/support/mount_init.rs` and is included only
with `integration-test-init`. It is not a standalone Cargo integration test.
