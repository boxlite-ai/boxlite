# BoxLite Integration Tests

This directory contains integration tests for the BoxLite runtime. Tests run concurrently via per-test isolation (`TempDir` + symlinked image cache). VM-based tests are **not run in CI** due to infrastructure requirements.

## Prerequisites

1. **Build the runtime**: The tests require `boxlite-shim` and `boxlite-guest` binaries.

   ```bash
   make runtime-debug
   ```

2. **Platform requirements**:
   - **macOS**: Apple Silicon (M1/M2/M3) with Hypervisor.framework
   - **Linux**: KVM support (`/dev/kvm` accessible)

## Test Files

| File | VM Required | Description |
|------|:-----------:|-------------|
| `lifecycle.rs` | Yes | Box lifecycle tests (create, start, stop, remove) |
| `execution_shutdown.rs` | Yes | Execution behavior during shutdown scenarios |
| `pid_file.rs` | Yes | PID file management and process tracking tests |
| `jailer.rs` | Yes | Jailer default behavior and macOS seatbelt deny lifecycle tests |
| `clone_export_import.rs` | Yes | Clone, export, and import operations |
| `sigstop_quiesce.rs` | Yes | SIGSTOP-based quiesce for snapshot operations |
| `rest_integration.rs` | Yes | REST API integration tests |
| `timing_profile.rs` | Yes | Boot latency profiling |
| `network.rs` | No | Network configuration tests |
| `runtime.rs` | No | Runtime initialization and configuration tests |
| `shutdown.rs` | No | Shutdown behavior (`IsolatedRuntime`, no VM) |

### macOS Seatbelt deny lifecycle tests

`jailer.rs` includes macOS-only integration tests that pass a custom
`sandbox_profile` to explicitly deny access to `<home_dir>/boxes`.

- With `jailer_enabled=true`, `start()` must fail and denial evidence must appear in `shim.stderr`.
- With `jailer_enabled=false`, the same profile is ignored and startup should succeed.
- `jailer.rs` test homes are created under `~/.boxlite-it` (non-default, short path) to avoid:
  - `/private/tmp` broad static seatbelt grants masking missing dynamic path access
  - macOS Unix socket path-length failures

## Running Tests

### With nextest (recommended)

```bash
# VM integration tests (uses vm profile with generous timeouts)
cargo nextest run -p boxlite --tests --profile vm

# Non-VM integration tests only
cargo nextest run -p boxlite --test runtime --test shutdown --test network

# Specific test file
cargo nextest run -p boxlite --test lifecycle --profile vm

# Single test
cargo nextest run -p boxlite --test execution_shutdown -E 'test(test_wait_behavior_on_box_stop)' --profile vm
```

### With Makefile

```bash
make test:integration
```

## Test Infrastructure

All test files use shared infrastructure from `common/mod.rs`. Three runtime flavors provide per-test isolation for concurrent execution:

### `ParallelRuntime` — VM integration tests

Per-test `TempDir` with symlinked image cache from `target/boxlite-test/`. On first use, a cross-process `flock` serializes the initial image pull and guest rootfs warmup. Subsequent tests reuse the cached artifacts.

```rust
use crate::common::ParallelRuntime;

#[tokio::test]
async fn test_box_lifecycle() {
    let ctx = ParallelRuntime::new();
    let handle = ctx.runtime.create(alpine_opts(), None).await.unwrap();
    handle.start().await.unwrap();
    // ... test logic ...
    handle.stop().await.unwrap();
    ctx.shutdown().await;
}
```

### `IsolatedRuntime` — non-VM tests

Per-test `TempDir` with no image cache. For tests that don't boot VMs: locking behavior, shutdown idempotency, config validation.

```rust
use crate::common::IsolatedRuntime;

#[tokio::test]
async fn test_shutdown_idempotent() {
    let ctx = IsolatedRuntime::new();
    // ... test logic using ctx.runtime ...
}
```

### `warm_temp_dir()` — recovery tests

Raw `TempDir` + symlinked image cache. For tests that create and drop multiple runtimes manually (e.g., crash recovery, state persistence across restarts).

```rust
use crate::common::warm_temp_dir;

#[tokio::test]
async fn test_recovery_after_crash() {
    let (temp_dir, home_dir) = warm_temp_dir();
    // Create first runtime, do work, drop it
    // Create second runtime with same home_dir, verify recovery
}
```

### macOS Socket Path Limits

macOS has a ~104 character limit on Unix socket paths (`SUN_LEN`).

- `jailer.rs` uses a short non-default base (`~/.boxlite-it`) with per-test `TempDir::new_in(...)`.
- This keeps socket paths short without relying on `/tmp` (which canonicalizes to `/private/tmp`).

## CI Exclusion

VM-based tests are excluded from CI because:

1. They require actual VM infrastructure (KVM or Hypervisor.framework)
2. They take significant time to run (VM boot, image pulls)
3. CI runners may not have virtualization enabled

To run in CI, you would need:
- A runner with nested virtualization or hardware virtualization support
- Pre-pulled images or registry access
- Extended timeouts for VM operations

## Troubleshooting

### "UnsupportedEngine" Error

You're running on an unsupported platform. BoxLite requires:
- macOS ARM64 (Apple Silicon)
- Linux x86_64/ARM64 with KVM

### Socket Path Too Long

If you see errors about socket paths, ensure the test home base path is short:

```rust
let base = dirs::home_dir().unwrap().join(".boxlite-it");
let temp_dir = TempDir::new_in(base).expect("Failed to create temp dir");
```

### Tests Hang

If tests hang, check:
1. `boxlite-shim` process is not stuck (check with `ps aux | grep boxlite`)
2. VM resources are available (memory, disk space)
3. No previous test left zombie processes

Kill orphaned processes:
```bash
pkill -f boxlite-shim
pkill -f boxlite-guest
```

### Image Pull Failures

Tests pull `alpine:latest` by default. Ensure:
1. Network connectivity to container registries
2. No firewall blocking registry access
3. Sufficient disk space for image cache (~50MB for Alpine)
