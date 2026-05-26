# PR: boxlite — Native Windows WHPX Support

**Title:** `feat(windows): add native Windows WHPX hypervisor support`

**Repo:** boxlite-labs/boxlite
**Branch:** feat/windows-whpx-support → main
**Stats:** 84 files changed, +6,133 / -523 (1 squashed commit)
**Depends on:** libkrun submodule PR (boxlite-ai/libkrun#TBD)

---

## Summary

Adds native Windows support to BoxLite using the Windows Hypervisor Platform (WHPX) API. This enables BoxLite to run lightweight Linux VMs directly on Windows without WSL2, providing the same SDK interface across all three platforms (macOS, Linux, Windows).

**What works:**
- Full VM lifecycle: create, start, exec, stop
- OCI image pull and ext4 disk construction on Windows
- Network connectivity (gvproxy + AF_UNIX vsock)
- Multi-vCPU (up to 4 vCPUs)
- Volume mounts (virtiofs via 9p)
- Python SDK on Windows
- Process isolation via Windows Job Objects

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                    Python/Node SDK                        │
├──────────────────────────────────────────────────────────┤
│                  boxlite (Rust core)                      │
│  ┌────────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │   image_disk   │  │    krun/     │  │   jailer/   │  │
│  │  (ext4 build)  │  │  engine.rs   │  │ job_object  │  │
│  └────────────────┘  └──────────────┘  └─────────────┘  │
├──────────────────────────────────────────────────────────┤
│              boxlite-shim (subprocess)                    │
│  ┌────────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │   watchdog     │  │   libkrun    │  │  gvproxy    │  │
│  │  (Event-based) │  │  (WHPX VMM)  │  │  (DLL)      │  │
│  └────────────────┘  └──────────────┘  └─────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Key Changes

### VM Engine (`src/boxlite/src/vmm/krun/`)

- **engine.rs** — Windows-specific VM lifecycle: `krun_start` (non-blocking) + `krun_wait` (poll for exit) + `krun_stop` (graceful shutdown). Linux/macOS use `krun_start_enter` (blocking, process takeover) which isn't available on Windows.
- **context.rs** — Merged import list for new libkrun APIs (`krun_add_virtiofs3`, `krun_add_net_unixgram`, `krun_add_vsock`, etc.)

### Process Lifecycle (`src/boxlite/src/vmm/controller/`)

- **spawn.rs** — `CREATE_SUSPENDED` + Job Object assignment + `ResumeThread` pattern to eliminate TOCTOU between spawn and sandboxing. PID file written from parent (no `pre_exec` on Windows).
- **watchdog.rs** — Windows implementation using named Events + parent process handle monitoring (replaces Unix pipe-based POLLHUP detection).
- **shim.rs** — Windows graceful shutdown via `krun_stop` API instead of Unix signals.

### Sandbox Isolation (`src/boxlite/src/jailer/`)

- **job_object.rs** — New Windows sandbox using Job Objects: process count limits, memory limits, kill-on-close semantics, and network restrictions via Silos (when available).

### Image & Disk (`src/boxlite/src/images/`)

- **image_disk.rs** — Platform-aware ext4 disk construction. On Windows, uses `mkfs.ext4` from bundled e2fsprogs and raw file I/O instead of loop devices. Layer extraction uses tar with Windows path handling.

### Networking

- **port.rs** — New module for TCP port availability checking (used by gvproxy on Windows).
- **socket_path.rs** — Cross-platform Unix socket path handling.

### Build System

- **build.rs** (boxlite) — Windows-specific dependency bundling (kernel, initrd, e2fsprogs, gvproxy DLL).
- **build.rs** (libkrun-sys) — Windows static library linking with MSVC.
- **build.rs** (libgvproxy-sys) — DLL import lib generation for Windows.

### Guest Agent (`src/guest/`)

- **zygote.rs** — Timeout-based container readiness (Windows has no `pidfd` for container PID1 monitoring).
- **mounts.rs** — Conditional bind-mount logic (no `/dev/kvm` passthrough on Windows guests).
- **virtiofs.rs** — 9p mount fallback path for Windows host.

### CI & Scripts

- `.github/workflows/test-windows.yml` — Windows build + unit test CI
- `.github/workflows/test-windows-e2e.yml` — Windows E2E test workflow
- `scripts/build/build-windows-runtime.sh` — Cross-compile all Windows runtime dependencies
- `scripts/build/cross-compile-*.sh` — Individual cross-compilation scripts (kernel, e2fsprogs, gvproxy)

### Cross-Platform Test Report

- `docs/cross-platform-test-report-20260503.md` — Full E2E test results across macOS ARM64, Win11, Win10

## Platform-Specific Behavior

| Aspect | macOS/Linux | Windows |
|--------|-------------|---------|
| Hypervisor | Hypervisor.framework / KVM | WHPX |
| VM lifecycle | `krun_start_enter` (blocking) | `krun_start` + `krun_wait` (async poll) |
| Shutdown | SIGTERM → guest | `krun_stop` API call |
| Watchdog | Pipe POLLHUP | Named Event + parent handle |
| Sandbox | sandbox-exec / seccomp | Job Objects |
| Disk build | losetup + mkfs.ext4 | Bundled e2fsprogs (raw file) |
| Networking | gvproxy (static lib) | gvproxy (DLL) |
| Process spawn | fork + pre_exec | CREATE_SUSPENDED + Job Object |

## Testing

### Automated (this PR)
- macOS ARM64: `cargo test -p boxlite --no-default-features --lib` — **689/689 PASS**
- Linux (Lima): `cargo test` — **673 PASS**, 26 fail (pre-existing, need `/dev/kvm`)
- `cargo clippy` — PASS (macOS + Linux)
- `cargo fmt` — PASS

### Manual E2E (Windows)
- **Win11** (ThinkPad T14, i5-1135G7, 16GB):
  - vm-bench 8/8 PASS (create, exec, file I/O, env, networking, stop)
  - net-test 8/8 PASS (DNS, HTTP, large transfer, concurrent connections)
  - BrowserBox: 4/6 PASS (lifecycle works; playwright_endpoint has unrelated libcontainer issue)
- **Win10** (MBP 2014, i7-4770HQ, 16GB):
  - vm-bench 8/8 PASS
  - net-test 8/8 PASS
  - BrowserBox: 6/6 PASS

### Cross-Platform Matrix

| Test Suite | macOS ARM64 | Win11 | Win10 |
|-----------|-------------|-------|-------|
| vm-bench (8 tests) | 8/8 PASS | 8/8 PASS | 8/8 PASS |
| net-test (8 tests) | 8/8 PASS | 8/8 PASS | 8/8 PASS |
| BrowserBox (6 tests) | 8/8 PASS | 4/6 PASS | 6/6 PASS |

## Test Plan

- [ ] CI: macOS + Linux builds unaffected (zero regression)
- [ ] CI: Windows build compiles successfully
- [ ] Manual: vm-bench passes on Windows (create/exec/stop lifecycle)
- [ ] Manual: net-test passes on Windows (guest networking)
- [ ] Code review: security of Job Object sandbox
- [ ] Code review: no secrets or credentials in committed files

## Known Limitations

1. **vCPU cap: 4** — Sufficient for the target use case (AI agent sandboxes). Can be raised later.
2. **No GPU passthrough** — WHPX doesn't support GPU virtualization. GPU workloads should use WSL2.
3. **First-boot image build is slow** — Large OCI images (>2GB) take several minutes for initial ext4 construction. Subsequent boots use cached disk.
4. **Win11 BrowserBox playwright_endpoint** — libcontainer sends unexpected `InitReady` message. Not WHPX-related; tracked separately.
