# Windows WHPX Support - Comprehensive Review Report

**Date**: 2026-04-30
**Branch**: `feat/windows-whpx-support`
**Commit**: `9882613` (Iterations 1-6 complete)
**Reviewer**: Claude Opus 4.6 (4 specialized review agents)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Approach Selection Review](#2-approach-selection-review)
3. [Architecture & Design Review](#3-architecture--design-review)
4. [Code Quality Review](#4-code-quality-review)
5. [Security Review](#5-security-review)
6. [Performance Review](#6-performance-review)
7. [Consolidated Findings](#7-consolidated-findings)
8. [Improvement Roadmap](#8-improvement-roadmap)

---

## 1. Executive Summary

The `feat/windows-whpx-support` branch adds native Windows Hypervisor Platform (WHPX) support to BoxLite. This is a substantial undertaking: ~20,000 lines of new VMM code in the libkrun vendor layer (38+ files), plus ~20 cfg-gated integration files in the boxlite crate. The implementation covers the full device emulation stack (PIC, PIT, Serial, IOAPIC, LAPIC, virtio-blk/net/vsock/9p/rng/balloon), multi-vCPU support, and platform integration (Job Objects, TCP transport, Event-based watchdog).

### Score Summary

| Dimension | Rating | Summary |
|-----------|--------|---------|
| Approach Selection | **Good** | WHPX is the correct choice for embeddable, daemon-free VM isolation |
| Architecture & Design | **Good** | Clean platform abstractions, well-layered interrupt architecture |
| Code Quality | **Good** | 4 important issues, 6 minor suggestions; well-tested |
| Security | **HIGH risk** | 1 Critical, 4 High, 5 Medium issues; reduced isolation vs Unix |
| Performance | **Acceptable** | Warm exec 3-24x slower than macOS; clear improvement path |

### Overall Assessment

The implementation demonstrates strong engineering judgment in making pragmatic tradeoffs. It is well-documented, has thorough E2E validation on real hardware (Win10 and Win11), and maintains clean separation from the existing macOS/Linux code. The primary concerns are security-related: the shift from kernel-mediated vsock to unauthenticated TCP localhost, and the reduced process isolation depth compared to Linux/macOS.

---

## 2. Approach Selection Review

### Decision: WHPX (Windows Hypervisor Platform)

**Rating: Good**

| Alternative | Why Not |
|---|---|
| **WSL2** | Not embeddable -- violates "SQLite for sandboxing" principle. Requires WSL2 installed. |
| **Hyper-V direct (WMI/HCS)** | Requires Hyper-V role (Enterprise/Pro only). HCS API undocumented and unstable. |
| **QEMU on Windows** | Heavy dependency (~30MB+). Not embeddable, requires separate process. |
| **Firecracker** | Linux-only. No Windows port exists. |

### Why WHPX is Correct

- **Broad availability**: Any Windows 10/11 with "Windows Hypervisor Platform" optional feature enabled. Works on Home, Pro, and Enterprise editions.
- **Embeddability**: WHPX is a DLL-based C API (`WinHvPlatform.dll`), fitting the static-linking model used by libkrun.
- **No daemon requirement**: Unlike Hyper-V's management layer, WHPX is a direct API call interface.
- **Major cost accepted**: WHPX provides CPU-only virtualization with zero device emulation, requiring ~14,000 lines of userspace device emulation code. This was a deliberate, documented tradeoff.

---

## 3. Architecture & Design Review

### 3.1. Shim Subprocess Model

**Rating: Good**

```
boxlite-runtime (parent)
    |
    +-- boxlite-shim.exe (child subprocess)
            |
            +-- libkrun (static library, linked into shim)
                    |
                    +-- WHPX partition (VM)
```

Reuses the existing Unix shim architecture unchanged. The engine code in `engine.rs` handles both Unix and Windows with minimal branching via well-scoped `#[cfg]` blocks. Key benefits:
- Uniform FFI surface (`krun_*` functions)
- Process isolation (WHPX crash doesn't bring down host app)
- Existing lifecycle management (`ShimHandler`/`ShimController`) works unmodified

### 3.2. Platform Abstraction (cfg-gating)

**Rating: Good**

Three clean patterns used consistently:
1. **Module-level gating**: `PlatformSandbox` type alias provides single dispatch point
2. **Inline cfg blocks**: Well-commented, minimal scope
3. **Platform-specific enum variants**: `NetworkBackendEndpoint::TcpSocket` behind `#[cfg(not(unix))]`

### 3.3. Transport: TCP instead of vsock

**Rating: Acceptable**

WHPX does not expose `AF_HYPERV` sockets to user-created partitions. The implementation uses TCP on `127.0.0.1` with ephemeral ports. This adds 4-24x latency overhead (warm exec ~5.5-33ms vs macOS ~1.4ms) but is adequate for the current production readiness target.

**Future direction**: Named Pipes, Windows Unix domain sockets (Win10 1803+), or shared memory ring buffers as potential optimizations.

### 3.4. Interrupt Architecture: PIC -> IOAPIC+LAPIC

**Rating: Good**

The migration was a **prerequisite** for multi-vCPU support. Well-layered in three files:
- `irq_chip.rs` -- coordinator with auto-detection of PIC-to-APIC transition
- `ioapic.rs` -- 24 redirection entries
- `lapic.rs` -- per-vCPU LAPIC with timer, SVR, ICR

The PIC remains as fallback for early boot (standard VMM practice). The auto-detection mirrors real hardware behavior.

### 3.5. Multi-vCPU: 2 vCPU Cap

**Rating: Acceptable**

Capped at 2 vCPUs via `cpus.clamp(1, 2)`. Root cause: single `Arc<Mutex<DeviceManager>>` creates lock contention during SMP timer calibration with 4+ vCPUs. The BSP starves on `tick_and_poll()`.

**Fix direction (documented)**: Per-vCPU LAPIC locks to eliminate cross-vCPU contention on MMIO reads. For AI sandbox workloads, 2 vCPUs is sufficient.

### 3.6. post_spawn() Trait Extension

**Rating: Good**

Clean trait extension with backward-compatible default no-op. `JobSandbox` overrides it for Job Object assignment. `CompositeSandbox` chains correctly. Unix sandboxes unaffected.

---

## 4. Code Quality Review

### Important Issues (Should Fix)

#### I-1. DRY violation: transform_*_to_vsock functions are near-identical

**File**: `src/boxlite/src/vmm/krun/engine.rs:68-235`

`transform_shell_arg_unix_to_vsock` and `transform_shell_arg_tcp_to_vsock` differ ONLY in the scheme prefix (`"unix://"` vs `"tcp://"`). ~80 lines of duplicate logic could be reduced to a single parameterized function:

```rust
fn transform_shell_arg_scheme_to_vsock(
    input: &str, arg_name: &str, scheme: &str, vsock_port: u32
) -> String { ... }
```

#### I-2. Inconsistent cfg attribute usage

Three different cfg predicates used for "Windows code":

| Pattern | Count | Semantic |
|---------|-------|----------|
| `#[cfg(target_os = "windows")]` | ~25 | Windows-only |
| `#[cfg(windows)]` | ~20 | Windows-only (equivalent) |
| `#[cfg(not(unix))]` | ~15 | All non-Unix (broader) |

The first two are semantically identical. `#[cfg(not(unix))]` is broader and occasionally leads to redundant double-gating (e.g., `process.rs` wrapping `#[cfg(target_os = "windows")]` inside `#[cfg(not(unix))]`).

**Recommendation**: Use `#[cfg(target_os = "windows")]` consistently for Windows-only code, `#[cfg(unix)]` for Unix-only, and `#[cfg(not(unix))]` only where code genuinely applies to all non-Unix platforms.

#### I-3. Windows RuntimeLock::drop does NOT explicitly unlock

**File**: `src/boxlite/src/runtime/lock.rs:136-151`

The Unix path explicitly unlocks (`libc::flock(fd, LOCK_UN)`) "for clarity," but Windows has no corresponding `UnlockFileEx` call. While Windows releases locks on `CloseHandle`, the asymmetry is misleading.

#### I-4. SYNCHRONIZE constant hardcoded instead of imported

**File**: `src/boxlite/src/bin/shim/main.rs:442-443`

```rust
const SYNCHRONIZE: u32 = 0x00100000;
```

Hardcoding a Windows SDK constant is fragile across `windows-sys` versions. Should be imported from `windows_sys::Win32::Foundation` or documented with the specific version requiring this workaround.

### Suggestions (Nice to Have)

| # | Issue | File |
|---|-------|------|
| S-1 | `ProcessMonitor::wait_for_exit` uses 500ms sleep polling (Rule #15: No Sleep for Events) | `process.rs:112-121` |
| S-2 | `#[allow(unreachable_code)]` in `shim.rs` stop() covers structurally unreachable `Ok(())` | `shim.rs:214` |
| S-3 | `JobSandbox` error messages lack Win32 error codes in `create_job_object()` | `job_object.rs:62,99` |
| S-4 | `DiskFormat` cfg-gating repeated twice (minor DRY opportunity) | `vmm_spawn.rs:173,277` |
| S-5 | Missing test for `system_check::check_whpx_available` error paths | `system_check.rs:537-571` |
| S-6 | `Keepalive::signal()` ignores `SetEvent` return value | `watchdog.rs:168-173` |

### Test Coverage Assessment

| Module | Tests | Platform | Assessment |
|--------|-------|----------|------------|
| `job_object.rs` | 5 | Windows | Good |
| `watchdog.rs` | 4 Win + 6 Unix | Both | Good |
| `port.rs` | 4 | Non-Unix | Good |
| `engine.rs` | 12 | Cross-platform | Good |
| `system_check.rs` | 2 Win + 3 other | Both | Adequate |
| `process.rs` | 15+ | Both | Good |
| `guest_connect.rs` | 8 | Both | Good |
| `lock.rs` | 6 | Cross-platform | Good |
| `crash_capture.rs` (Windows exception handler) | 0 | Windows | Gap (hard to unit test) |
| `shim/main.rs` (Windows ctrl handler) | 0 | Windows | Gap (global state) |

**Overall**: Test gaps are concentrated in areas involving global process state (signal/exception handlers), which are covered by E2E tests.

---

## 5. Security Review

### Severity Summary

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High | 4 |
| Medium | 5 |
| Low | 3 |
| Info | 2 |
| **Overall Risk** | **HIGH** |

### Critical Issues

#### C-1. TOCTOU Race in Job Object Assignment

**Location**: `job_object.rs:129-162`, `spawn.rs:119-131`

The child process runs unrestricted between `cmd.spawn()` and `AssignProcessToJobObject()`. During this window, the child can spawn grandchild processes outside the Job Object, consume unlimited memory, or become orphaned if the parent crashes.

On Linux, `pre_exec` hooks apply isolation atomically (post-fork, pre-exec). On Windows, there is no atomic mechanism.

**Remediation**: Use `CREATE_SUSPENDED` flag via `CreateProcessW`, assign to Job Object before resuming. Requires custom spawn implementation since `std::process::Command` doesn't expose this.

### High Issues

#### H-1. TCP Localhost Transport Exposes VM Communication

**Location**: `connection.rs:89-104`, `port.rs:1-52`, `engine.rs:561-600`

All three VM communication channels (gRPC, ready, network) use TCP on `127.0.0.1` with no authentication. Any local process can connect to the gRPC port and issue commands to the guest.

On Unix, vsock/Unix domain sockets are kernel-mediated and permission-protected.

**Remediation options**:
1. Named Pipes (Windows) with ACLs
2. mTLS on gRPC with ephemeral certs
3. Per-box authentication tokens via stdin
4. Windows Unix domain sockets (Win10 1803+)

#### H-2. No Breakaway Protection on Job Object

**Location**: `job_object.rs:58-105`

The Job Object only configures: kill-on-close, memory limit, process count limit. Missing:
- UI restrictions (`JOB_OBJECT_UILIMIT_*`)
- `JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION`
- Security limit class

Compared to Linux (namespaces + seccomp + Landlock + cgroup) and macOS (seatbelt SBPL), this is substantially less isolation.

#### H-3. Watchdog Event Handle Accessible to Other Local Processes

**Location**: `watchdog.rs:213-252`

The handle value is passed via `BOXLITE_SHUTDOWN_EVENT` environment variable and is inheritable. Any process that can read the shim's environment or duplicate the handle can trigger premature shutdown.

**Remediation**: Use anonymous pipes on Windows instead of events, matching the Unix pattern.

#### H-4. Debugfs Command Injection via Crafted OCI Layer Paths

**Location**: `image_disk.rs:635-751`

Paths from OCI tar headers are interpolated directly into debugfs command strings without sanitization. A path containing newlines or debugfs metacharacters could inject arbitrary commands.

**Remediation**: Sanitize all tar header paths before interpolation. Reject/escape newlines, quotes, backslashes.

### Medium Issues

| # | Issue | Location |
|---|-------|----------|
| M-1 | No path traversal validation on tar symlink targets | `image_disk.rs:580` |
| M-2 | Missing Win32 error codes in Job Object creation errors | `job_object.rs:60-65` |
| M-3 | Memory limit cast `as usize` without overflow check | `job_object.rs:77-84` |
| M-4 | Debugfs command files at predictable temp paths (symlink attack) | `image_disk.rs:702-705` |
| M-5 | PID file written non-atomically on Windows | `spawn.rs:154-164` |

### Windows Isolation Depth Comparison

| Layer | Linux | macOS | Windows |
|-------|-------|-------|---------|
| Filesystem isolation | Mount namespace + pivot_root | Seatbelt SBPL | **None** |
| Syscall filtering | seccomp-BPF | Seatbelt | **None** |
| Network isolation | Network namespace + Landlock | Seatbelt | **None** |
| Resource limits | cgroups v2 + rlimits | rlimits | Job Object (memory + process count) |
| Process isolation | PID namespace | N/A | Job Object kill-on-close |
| Transport | vsock (kernel-mediated) | vsock (kernel-mediated) | **TCP localhost (no auth)** |
| Parent death detection | Pipe POLLHUP (tamper-proof) | Pipe POLLHUP (tamper-proof) | Event + parent handle (weaker) |

---

## 6. Performance Review

### Benchmark Reference

| Metric | macOS (M5) | Win11 (i5-1135G7) | Win10 (i7-4770HQ) |
|--------|-----------|-------------------|-------------------|
| cold exec | 1,056ms | 1,259ms | 1,265ms |
| warm exec (avg) | 2.0ms | 6.5ms | 47.7ms |
| warm exec (p95) | 4.0ms | 7.8ms | 55.2ms |
| stop | 2,102ms | 319ms | 425ms |

### Area 1: HLT Tiered Sleep (spin 50 iters, then sleep 200us)

**Assessment: Well-designed**

The tiered approach (5 IRQ checks during spin, then 200us sleep) is sound in design. However, `std::thread::sleep(200us)` on Windows actually sleeps 1-15ms due to the default Windows timer resolution (15.625ms). Unless `timeBeginPeriod(1)` is called, the 200us target is never achieved.

### Area 2: LAPIC Timer Tick Throttle (skip if <500us elapsed)

**Assessment: Safe and appropriate**

The 500us throttle does not affect timer calibration accuracy because CCR reads (`current_count()`) are called directly on each MMIO exit, not throttled. The throttle only affects `tick_timer()` interrupt delivery, adding up to 500us latency on a 10ms period timer -- negligible.

### Area 3: Warm Exec Gap Root Cause

**Root cause: Raw disk copy (256MB) on Windows vs QCOW2 COW (512 bytes) on Unix**

| Platform | Mechanism | Disk Copy Time |
|----------|-----------|----------------|
| macOS/Linux | QCOW2 COW child disk (512-byte header) | ~1ms |
| Win11 (NVMe) | `std::fs::copy()` 256MB | ~3-4ms |
| Win10 (SATA) | `std::fs::copy()` 256MB | ~35-40ms |

The Win10 vs Win11 gap (47.7ms vs 6.5ms) is almost entirely storage hardware: SATA SSD (500MB/s) vs NVMe SSD (3000+ MB/s).

### Area 4: 2-vCPU Cap (DeviceManager Mutex Contention)

**Root cause**: All devices behind single `Arc<Mutex<DeviceManager>>`. The LAPICs are already per-vCPU data structures, but accessed through the shared mutex. Fix direction: move LAPICs outside the DeviceManager mutex into per-vCPU locks, split MMIO dispatch for LAPIC addresses.

### Area 5: TCP Transport Overhead

TCP loopback with `TCP_NODELAY` adds ~0.5-1ms per gRPC call vs vsock. Minor contributor relative to disk copy cost.

### Top 3 Performance Improvement Opportunities

| Rank | Improvement | Impact | Effort | Risk |
|------|------------|--------|--------|------|
| **1** | Disk copy elimination (reflink or QCOW2 COW) | -40ms Win10, -4ms Win11 | 1-15 days | Low-High |
| **2** | Per-vCPU LAPIC locking (remove 2-vCPU cap) | Enables 4+ vCPUs, 30-50% throughput | 5-7 days | Medium |
| **3** | HLT sleep resolution (`timeBeginPeriod` + WaitableTimer) | -1-2ms latency, better responsiveness | 2-3 days | Low |

#### Rank 1 Detail: Disk Copy Elimination

**Option A (simplest)**: Windows reflink via `FSCTL_DUPLICATE_EXTENTS_TO_FILE`. Works on ReFS/DevDrive. ~1 day. Falls back to `std::fs::copy()` if unsupported.

**Option B (moderate)**: Sparse file + lazy copy. ~3-5 days.

**Option C (complex)**: QCOW2 block driver in WHPX VMM. ~2-3 weeks. Most complete.

---

## 7. Consolidated Findings

### By Priority

| Priority | Category | Count | Key Items |
|----------|----------|-------|-----------|
| **P0 (Critical)** | Security | 1 | TOCTOU in Job Object assignment (C-1) |
| **P1 (High)** | Security | 4 | TCP no auth (H-1), Job Object gaps (H-2), watchdog exposure (H-3), debugfs injection (H-4) |
| **P1 (High)** | Performance | 1 | Disk copy bottleneck (47.7ms on Win10) |
| **P2 (Medium)** | Security | 5 | Path traversal (M-1), error codes (M-2), integer overflow (M-3), temp files (M-4), PID file (M-5) |
| **P2 (Medium)** | Code Quality | 4 | DRY violation (I-1), cfg inconsistency (I-2), lock asymmetry (I-3), hardcoded constant (I-4) |
| **P3 (Low)** | Performance | 2 | Per-vCPU LAPIC locking, HLT sleep resolution |
| **P3 (Low)** | Code Quality | 6 | Various minor improvements |
| **P3 (Low)** | Security | 3 | Log level (L-1), secret zeroize (L-2), key lifecycle (L-3) |

### What Was Done Well

1. **Excellent architectural decisions** -- reuses existing Unix patterns without imposing Windows-specific abstractions on shared code
2. **Proper abstraction boundaries** -- `PlatformSandbox` type alias, `post_spawn()` trait extension, `NetworkBackendEndpoint` enum variant
3. **Strong error messages** -- almost every Windows API call includes `std::io::Error::last_os_error()` context
4. **Thorough E2E validation** -- tested on real Win10 and Win11 hardware, BrowserBox verified
5. **Good test coverage** -- 521 unit tests on Windows, 13 functional + 8 network + 5 stability E2E tests
6. **Documentation quality** -- module-level doc comments explain both what and why

---

## 8. Improvement Roadmap

### Phase 1: Security Hardening (Before Production)

| Item | Priority | Effort |
|------|----------|--------|
| C-1: `CREATE_SUSPENDED` spawn pattern | P0 | 2-3 days |
| H-1: Per-box auth tokens on gRPC channel | P1 | 2-3 days |
| H-2: Job Object UI restrictions | P1 | 1 day |
| H-4: Debugfs path sanitization | P1 | 1 day |
| M-2: Win32 error codes in all error paths | P2 | 0.5 day |
| M-4: Use `tempfile::NamedTempFile` for debugfs commands | P2 | 0.5 day |

### Phase 2: Performance Optimization

| Item | Priority | Effort |
|------|----------|--------|
| Disk copy elimination (Option A: reflink) | P1 | 1-2 days |
| `timeBeginPeriod(1)` + WaitableTimer | P3 | 2-3 days |
| Per-vCPU LAPIC locking (4+ vCPU support) | P3 | 5-7 days |

### Phase 3: Code Quality Polish

| Item | Priority | Effort |
|------|----------|--------|
| I-1: Refactor `transform_*_to_vsock` (DRY) | P2 | 0.5 day |
| I-2: Standardize cfg attribute convention | P2 | 1 day |
| I-3: Symmetric lock/unlock in `RuntimeLock` | P2 | 0.5 day |
| I-4: Import or document `SYNCHRONIZE` constant | P2 | 0.5 day |

---

*Report generated by 4 specialized review agents: Architecture, Security, Code Quality, Performance.*
*Total files reviewed: 42 source files across `src/boxlite/` and `src/deps/libkrun-sys/vendor/`.*
