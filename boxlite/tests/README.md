# BoxLite Integration Tests

This directory contains integration tests for the BoxLite runtime. These tests require a real VM environment and are **not run in CI** due to infrastructure requirements.

## Prerequisites

1. **Build the runtime**: The tests require `boxlite-shim` and `boxlite-guest` binaries.

   ```bash
   make runtime-debug
   ```

2. **Set environment variable** (optional): By default, tests use temporary home directories. For debugging, you can specify a persistent runtime artifact directory:

   ```bash
   export BOXLITE_RUNTIME_DIR=/path/to/runtime/dir
   ```

3. **Platform requirements**:
   - **macOS**: Apple Silicon (M1/M2/M3) with Hypervisor.framework
   - **Linux**: KVM support (`/dev/kvm` accessible)

## Test Files

| File | Description |
|------|-------------|
| `lifecycle.rs` | Box lifecycle tests (create, start, stop, remove) |
| `runtime.rs` | Runtime initialization and configuration tests |
| `network.rs` | Network configuration and connectivity tests |
| `pid_file.rs` | PID file management and process tracking tests |
| `execution_shutdown.rs` | Execution behavior during shutdown scenarios |
| `jailer.rs` | Jailer default behavior and macOS seatbelt deny lifecycle tests |

### macOS Seatbelt deny lifecycle tests

`jailer.rs` includes macOS-only integration tests that pass a custom
`sandbox_profile` to explicitly deny access to `<home_dir>/boxes`.

- With `jailer_enabled=true`, `start()` must fail and denial evidence must appear in `shim.stderr`.
- With `jailer_enabled=false`, the same profile is ignored and startup should succeed.
- `jailer.rs` test homes are created under `~/.boxlite-it` (non-default, short path) to avoid:
  - `/private/tmp` broad static seatbelt grants masking missing dynamic path access
  - macOS Unix socket path-length failures

## Running Tests

### All Integration Tests

```bash
# Using Makefile (recommended)
make test:integration

# Manual cargo command
BOXLITE_RUNTIME_DIR=$(pwd)/target/boxlite-runtime \
  cargo test -p boxlite --tests --no-fail-fast -- --test-threads=1 --nocapture
```

### Specific Test File

```bash
# Run all tests in a file
cargo test -p boxlite --test lifecycle -- --nocapture

# Run execution shutdown tests
cargo test -p boxlite --test execution_shutdown -- --nocapture
```

### Single Test

```bash
cargo test -p boxlite --test execution_shutdown test_wait_behavior_on_box_stop -- --nocapture
```

## Test Patterns

### TestContext Pattern

All test files use a common `TestContext` pattern for isolation:

```rust
struct TestContext {
    runtime: BoxliteRuntime,
    _temp_dir: TempDir,  // Dropped after test, cleaning up
}

impl TestContext {
    fn new() -> Self {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let options = BoxliteOptions {
            home_dir: temp_dir.path().to_path_buf(),
            image_registries: vec![],
        };
        let runtime = BoxliteRuntime::new(options).expect("Failed to create runtime");
        Self { runtime, _temp_dir: temp_dir }
    }
}
```

### macOS Socket Path Limits

macOS has a ~104 character limit on Unix socket paths (`SUN_LEN`).

- `jailer.rs` uses a short non-default base (`~/.boxlite-it`) with per-test `TempDir::new_in(...)`.
- This keeps socket paths short without relying on `/tmp` (which canonicalizes to `/private/tmp`).

## CI Exclusion

These tests are excluded from CI because:

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
