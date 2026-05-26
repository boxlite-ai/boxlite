# Windows WHPX Comprehensive E2E Test Report

**Date**: 2026-04-30
**Branch**: `feat/windows-whpx-support`
**Commit**: `9882613` (Iter 6: JobSandbox + Production Hardening)
**Iterations Complete**: 1, 1.5, 2, 3, 4, 5, 6

## Test Machines

| Machine | OS | CPU | RAM | Hypervisor | Role |
|---------|------|-----|-----|------------|------|
| MacBook Pro M5 | macOS 15 (Darwin 25.2.0) | Apple M5 (ARM64) | 24GB | Hypervisor.framework | Development + macOS unit tests + E2E |
| Lima VM (on M5) | Ubuntu (aarch64, vz driver) | Apple M5 (shared) | Shared | N/A (no KVM) | Linux unit tests regression check |
| IBM ThinkPad T14 Gen2 | Windows 11 | Intel i5-1135G7 (4C/8T) | 16GB | WHPX (Hyper-V) | Win11 E2E + unit tests |
| MacBook Pro 2014 Mid | Windows 10 | Intel i7-4770HQ (4C/8T) | 16GB | WHPX (Hyper-V) | Win10 E2E + unit tests |

## Summary: ALL PASS, ZERO REGRESSIONS

| Platform | Unit Tests | Stability (5 rounds) | Functional (13 tests) | Net-Test (8 tests) | Status |
|----------|-----------|----------------------|-----------------------|--------------------|--------|
| **macOS** (M5, ARM64) | 636/636 PASS | 5/5 (100%) | 13/13 (100%) | N/A | **PASS** |
| **Linux** (Lima, aarch64) | 622/646 (24 known failures*) | N/A | N/A | N/A | **PASS** |
| **Win11** (T14, i5-1135G7) | 521/521 PASS | 5/5 (100%) | 13/13 (100%) | 8/8 (100%) | **PASS** |
| **Win10** (MBP 2014, i7-4770HQ) | 521/521 PASS | 5/5 (100%) | 13/13 (100%) | 8/8 (100%) | **PASS** |

*24 Linux failures are pre-existing `runtime::rt_impl::tests::*` -- require `/dev/kvm`, not available in Lima VM. No new failures.

## Unit Test Commands

| Platform | Command |
|----------|---------|
| macOS | `cargo test -p boxlite --no-default-features --lib` |
| Linux | `CARGO_TARGET_DIR="$HOME/boxlite-target" BOXLITE_DEPS_STUB=1 cargo test -p boxlite --no-default-features --lib` |
| Windows | `BOXLITE_DEPS_STUB=1 cargo test -p boxlite --no-default-features --lib` |

## Performance Comparison

| Metric | macOS (M5) | Win11 (T14) | Win10 (MBP 2014) |
|--------|------------|-------------|------------------|
| cold exec | 1,056ms | 1,259ms | 1,265ms |
| warm exec (avg x10) | 2.0ms | 6.5ms | 47.7ms |
| warm exec (p95) | 4.0ms | 7.8ms | 55.2ms |
| stop | 2,102ms | 319ms | 425ms |
| remove | 7.8ms | 76.5ms | 69.2ms |
| VM lifecycle total | 3,169ms | 1,664ms | 1,811ms |
| Grand total | 3,187ms | 1,723ms | 2,240ms |

## Functional Test Coverage (13 scenarios)

All 13 pass on macOS, Win10, and Win11:

| # | Test | Description | Win11 Time | Win10 Time | macOS Time |
|---|------|-------------|------------|------------|------------|
| 1 | echo_hello | Basic stdout | 1,310ms | 1,765ms | N/A |
| 2 | exit_code_zero | Success exit | 7.8ms | 44.8ms | N/A |
| 3 | exit_code_nonzero | Error exit (code=1) | 4.6ms | 43.2ms | N/A |
| 4 | command_not_found | Error handling | 3.3ms | 40.8ms | N/A |
| 5 | multi_arg_ls | Multi-arg commands | 10.3ms | 46.2ms | N/A |
| 6 | env_variable | Environment passing | 7.8ms | 45.9ms | N/A |
| 7 | working_directory | cwd configuration | 1,692ms | 2,400ms | 3,105ms |
| 8 | file_write_read | Filesystem I/O | 14.3ms | 60.9ms | 44.1ms |
| 9 | binary_md5 | Binary execution | 6.3ms | 48.3ms | 2.2ms |
| 10 | warm_exec_x20 | Rapid sequential exec | 186ms | 925ms | 32ms |
| 11 | exec_timeout | Timeout handling | 4,684ms | 4,822ms | 6,176ms |
| 12 | large_output | 10K lines stdout | 39.9ms | 53.1ms | 73.4ms |
| 13 | lifecycle_manual | Full create/start/exec/stop/remove | 1,673ms | 2,026ms | 3,228ms |

## Networking Tests (8 scenarios)

All 8 pass on Win10 and Win11:

| # | Test | Win11 Time | Win10 Time |
|---|------|------------|------------|
| 1 | eth0 exists | 48ms | 45ms |
| 2 | eth0 has IP (192.168.127.2) | 18ms | 48ms |
| 3 | Default route via gateway | 4ms | 43ms |
| 4 | resolv.conf DNS config | 5ms | 44ms |
| 5 | Ping gateway (192.168.127.1) | 7ms | 45ms |
| 6 | DNS resolve (nslookup) | 24ms | 75ms |
| 7 | wget http://example.com | 443ms | 472ms |
| 8 | wget https://example.com | 1,809ms | 768ms |

## Windows-Specific Unit Tests (Win11)

JobSandbox tests (5/5 PASS):
- `test_job_sandbox_is_available` -- Job Objects available on all Windows versions
- `test_job_sandbox_name` -- Returns "job-object"
- `test_post_spawn_without_setup_fails` -- Validates setup() must be called first
- `test_post_spawn_assigns_to_job_object` -- AssignProcessToJobObject succeeds
- `test_create_job_object_succeeds` -- Job Object with 512MB + 64 process limits

Watchdog tests (4/4 PASS):
- `test_create_returns_valid_event` -- Event handle creation
- `test_event_is_inheritable` -- Handle inheritance for child processes
- `test_keepalive_drop_signals_event` -- Kill-on-close signaling
- `test_keepalive_signal_sets_event` -- Manual signal

## Fixes Applied During Testing

1. **`JobSandbox` missing `#[derive(Debug)]`** -- `Jailer<S>` derives Debug, so `S: Sandbox` must implement Debug. Added derive.
2. **`DuplicateHandle` wrong import path** -- In `windows-sys` 0.61, `DuplicateHandle` is in `Win32::Foundation`, not `Win32::System::Threading`. Fixed in `watchdog.rs`.

## Regression Analysis

- **macOS**: 636/636 PASS -- identical to pre-Iter-6. Zero regressions.
- **Linux**: 622 PASS + 24 known failures -- identical to baseline. Zero regressions.
- **Windows**: All `#[cfg(windows)]` code paths verified with 521 unit tests + 26 E2E scenarios.
- **Cross-platform**: All Iter 6 changes are `#[cfg(target_os = "windows")]` gated except:
  - `post_spawn()` default no-op in Sandbox trait (zero impact on Linux/macOS)
  - `CompositeSandbox::post_spawn()` chaining (delegates to children, all return Ok(()))

## Test Infrastructure

- **Stability suite**: `cross_platform_e2e.py --rounds 5` (create/exec/stop/remove per round, 90s timeout)
- **Functional suite**: 13 test cases covering echo, exit codes, env vars, cwd, file I/O, warm exec, timeout, large output, lifecycle
- **Performance suite**: Phase-level timings with warm-exec statistical analysis (min/avg/max/p50/p95)
- **Net-test**: 8 networking scenarios (interface, IP, routing, DNS, HTTP/HTTPS connectivity)

