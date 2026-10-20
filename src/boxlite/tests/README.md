# BoxLite Integration Tests

This directory contains integration tests for the BoxLite runtime. Tests run concurrently via per-test isolation (`TempDir` + symlinked image cache). VM-based tests are **not run in CI** due to infrastructure requirements.

## Prerequisites

1. **Build the runtime**: The tests require `boxlite-shim` and `boxlite-guest` binaries.

   ```bash
   make runtime:debug
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
| `shutdown.rs` | No | Shutdown behavior (isolated home, no VM) |

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

All test files use shared infrastructure from `boxlite-test-utils` and `common/mod.rs`. Per-test isolation is achieved via `PerTestBoxHome` which creates a temporary directory with optional symlinked image cache.

### `PerTestBoxHome::new()` — VM integration tests

Per-test `TempDir` with symlinked image cache from `target/boxlite-test/`. On first use, a cross-process `flock` serializes the initial image pull and guest rootfs warmup. Subsequent tests reuse the cached artifacts.

```rust
use boxlite_test_utils::home::PerTestBoxHome;

#[tokio::test]
async fn test_box_lifecycle() {
    let home = PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    }).expect("create runtime");
    let handle = runtime.create(alpine_opts(), None).await.unwrap();
    handle.start().await.unwrap();
    // ... test logic ...
    handle.stop().await.unwrap();
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}
```

### `PerTestBoxHome::isolated()` — non-VM tests

Per-test `TempDir` with no image cache. For tests that don't boot VMs: locking behavior, shutdown idempotency, config validation.

```rust
use boxlite_test_utils::home::PerTestBoxHome;

#[tokio::test]
async fn test_shutdown_idempotent() {
    let home = PerTestBoxHome::isolated();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    }).expect("create runtime");
    // ... test logic using runtime ...
}
```

### Other `PerTestBoxHome` constructors

- `PerTestBoxHome::new_in(base)` — warm cache under a custom base directory (e.g., `~/.boxlite-it` for short socket paths)
- `PerTestBoxHome::isolated_in(base)` — no cache under a custom base directory

### `test_registries()` — the local registry

Every box built from a tag asks its registry for that tag again, so a public registry in the test
list puts the internet into every box start. `test_registries()` lists only the process's local
registry (`registry::local_registry()`, plain HTTP on `127.0.0.1`), as designed in
[#1996](https://github.com/boxlite-ai/boxlite/issues/1996).

- It serves manifests and blobs recorded under `target/boxlite-test/registry/`. A miss is fetched
  once from whichever `UPSTREAM_REGISTRIES` entry answers first, then replayed.
- A recorded tag never moves. Delete `target/boxlite-test/registry/` to record current builds.
- CLI tests pass it through `common::write_registry_config`, since `--registry` takes HTTPS hosts
  only. `src/cli/tests/registry.rs` tests that flag, so it still reaches a public mirror.
- `make test:integration:python` and `make test:integration:node` run their suites under
  `with-local-registry` (`src/test-utils/src/bin/`), which starts the same registry and sets
  `BOXLITE_TEST_REGISTRY=127.0.0.1:<port>`. Their harnesses list only that registry when it is
  set. Run without `make`, a suite pulls from public mirrors and its harness contract test
  (`test_harness_registry.py`, `harness-registry.integration.test.ts`) fails.
- The C suite's integration test calls `boxlite_simple_new`, which takes no registries, so it
  still pulls from docker.io.
- `BOXLITE_TEST_REGISTRIES=upstream` switches every suite back to the public mirrors:
  `test_registries()` returns `UPSTREAM_REGISTRIES` and make runs the SDK suites without the
  wrapper. The contract tests then check for the mirrors instead. The default is `local`; any
  other value makes `test_registries()` panic.
- The Rust upstream-mode contract test sets `BOXLITE_TEST_REGISTRIES` only for a child
  process. It checks the actual `test_registries()` result without changing the parent
  environment, so parallel `cargo test` runs cannot switch another test's registry mode.
  Rust recommends [`Command::env` for this isolation](https://doc.rust-lang.org/std/env/fn.set_var.html#safety).
- Behind an HTTP proxy, set `no_proxy=127.0.0.1,localhost`; otherwise requests to the local
  registry go through the proxy.

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
let home = PerTestBoxHome::new_in(base.to_str().unwrap());
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

Tests pull `alpine:latest` by default, through the local registry. Only an image it has not
recorded needs the network. Ensure:
1. Network connectivity to the `UPSTREAM_REGISTRIES` mirrors on first use
2. No firewall blocking registry access
3. Sufficient disk space for image cache (~50MB for Alpine)

A `MANIFEST_UNKNOWN` or `BLOB_UNKNOWN` answer saying `no upstream has …` lists each upstream's
error.
