# Windows WHPX Support - Comprehensive Review Report (v2)

**Date**: 2026-04-30
**Branch**: `feat/windows-whpx-support`
**Commit**: `9882613` (Iterations 1-6 complete)
**Reviewer**: Claude Opus 4.6 (4 specialized review agents x 2 rounds)
**Version**: v2 (cross-verified against source code)

---

## Changelog from v1

v2 is a verification pass of v1. Each finding was re-checked against the actual source code by dedicated review agents. Changes are marked with **[v2]** annotations.

| Category | v1 Findings | v2 Status |
|----------|-------------|-----------|
| Architecture (6 findings) | 6 | 4 CONFIRMED, 2 PARTIALLY CORRECT (minor inaccuracies corrected) |
| Code Quality (10 findings) | 10 | 8 CONFIRMED, 2 PARTIALLY CORRECT (counts corrected) |
| Security (10 findings) | 10 | 7 CONFIRMED, 3 PARTIALLY CORRECT (severity adjusted) + 4 NEW |
| Performance (5 areas + top 3) | 8 | 5 CONFIRMED, 3 PARTIALLY CORRECT (details refined) + 1 NEW |
| **Net effect** | **Severity rebalanced**: C-1 downgraded HIGH, H-2/H-3 downgraded MEDIUM; 4 new security items added |

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

The `feat/windows-whpx-support` branch adds native Windows Hypervisor Platform (WHPX) support to BoxLite. This is a substantial undertaking: ~20,000 lines of new VMM code in the libkrun vendor layer (39 files across 5 directory levels), plus ~15 cfg-gated integration files in the boxlite crate (~40 cfg blocks). The implementation covers the full device emulation stack (PIC, PIT, Serial, IOAPIC, LAPIC, virtio-blk/net/vsock/9p/rng/balloon), multi-vCPU support, and platform integration (Job Objects, TCP transport, Event-based watchdog).

### Score Summary

| Dimension | Rating | Summary |
|-----------|--------|---------|
| Approach Selection | **Good** | WHPX is the correct choice for embeddable, daemon-free VM isolation |
| Architecture & Design | **Good** | Clean platform abstractions, well-layered interrupt architecture |
| Code Quality | **Good** | 4 important issues, 6 minor suggestions; well-tested |
| Security | **MEDIUM-HIGH risk** | **[v2]** 0 Critical (downgraded), 3 High, 5 Medium; reduced isolation vs Unix |
| Performance | **Acceptable** | Warm exec 3-24x slower than macOS; clear improvement path |

**[v2] Key severity changes from v1:**
- C-1 (TOCTOU): CRITICAL -> **HIGH** -- child is trusted boxlite-shim binary, not user code
- H-2 (Job Object): HIGH -> **MEDIUM** -- breakaway is blocked by default (not setting BREAKAWAY_OK IS the secure default)
- H-3 (Watchdog): HIGH -> **MEDIUM** -- exploiting requires existing local access to process environment
- Overall risk: HIGH -> **MEDIUM-HIGH**

### Overall Assessment

The implementation demonstrates strong engineering judgment in making pragmatic tradeoffs. It is well-documented, has thorough E2E validation on real hardware (Win10 and Win11), and maintains clean separation from the existing macOS/Linux code. The primary concerns are security-related: the shift from kernel-mediated vsock to unauthenticated TCP localhost, and the reduced process isolation depth compared to Linux/macOS. However, the v1 report overstated several security risks by not accounting for the fact that the spawned child is a trusted binary (not arbitrary user code), and that some Windows defaults are already secure.

---

## 2. Approach Selection Review

### Decision: WHPX (Windows Hypervisor Platform)

**Rating: Good** -- CONFIRMED in v2, no changes.

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

**Rating: Good** -- **[v2] PARTIALLY CORRECT**: "Minimal branching" understated; more accurately "moderate, well-contained branching."

```
boxlite-runtime (parent)
    |
    +-- boxlite-shim.exe (child subprocess)
            |
            +-- libkrun (static library, linked into shim)
                    |
                    +-- WHPX partition (VM)
```

Reuses the existing Unix shim architecture. The engine code in `engine.rs` handles both Unix and Windows with **moderate** branching via well-scoped `#[cfg]` blocks. Key benefits:
- Uniform FFI surface (`krun_*` functions)
- Process isolation (WHPX crash doesn't bring down host app)
- Existing lifecycle management (`ShimHandler`/`ShimController`) works unmodified

**[v2] Detail**: `engine.rs` contains 4 `#[cfg(not(unix))]` blocks plus ~100 lines of TCP-to-vsock transformation infrastructure added specifically for Windows. Across the full boxlite crate, there are ~40 cfg-gated blocks in ~15 files. The code is well-organized but represents a non-trivial amount of platform-specific logic.

### 3.2. Platform Abstraction (cfg-gating)

**Rating: Good** -- CONFIRMED in v2.

Three clean patterns used consistently:
1. **Module-level gating**: `PlatformSandbox` type alias provides single dispatch point (`sandbox/mod.rs:164-174`)
2. **Inline cfg blocks**: Well-commented, focused scope
3. **Platform-specific enum variants**: `NetworkBackendEndpoint::TcpSocket` behind `#[cfg(not(unix))]` (`net/mod.rs:49-54`)

### 3.3. Transport: TCP instead of vsock

**Rating: Acceptable** -- CONFIRMED in v2.

WHPX does not expose `AF_HYPERV` sockets to user-created partitions. The implementation uses TCP on `127.0.0.1` with ephemeral ports, consistently wired through the entire stack (transport selection in `vmm_spawn.rs`, engine bridge in `engine.rs`, portal connection in `connection.rs`, network backend in `gvproxy/instance.rs`).

**Future direction**: Named Pipes, Windows Unix domain sockets (Win10 1803+), or shared memory ring buffers as potential optimizations.

### 3.4. Interrupt Architecture: PIC -> IOAPIC+LAPIC

**Rating: Good** -- **[v2] PARTIALLY CORRECT**: File paths corrected.

The migration was a **prerequisite** for multi-vCPU support. Well-layered in three files under `windows/devices/` (**[v2]** not directly under `windows/` as v1 stated):
- `devices/irq_chip.rs` -- coordinator with `apic_mode` boolean for auto-detection of PIC-to-APIC transition
- `devices/ioapic.rs` -- 24 redirection entries
- `devices/lapic.rs` -- per-vCPU LAPIC with timer, SVR, ICR

The PIC remains as fallback for early boot (standard VMM practice). The auto-detection mirrors real hardware behavior.

**[v2] Additional context**: The total Windows VMM codebase is **39 Rust source files** across `windows/`, `windows/boot/`, `windows/devices/`, and `windows/devices/virtio/` (plus subdirectories for p9/ and vsock/). This is a substantial custom VMM implementation.

### 3.5. Multi-vCPU: 2 vCPU Cap

**Rating: Acceptable** -- CONFIRMED in v2.

Capped at 2 vCPUs via `cpus.clamp(1, 2)` at `engine.rs:339`. Root cause documented in a 7-line comment: single `Arc<Mutex<DeviceManager>>` (created at `runner.rs:314`) with **17 lock acquisition sites** creates lock contention during SMP timer calibration with 4+ vCPUs. The BSP starves on `tick_and_poll()`.

**Fix direction (documented)**: Per-vCPU LAPIC locks to eliminate cross-vCPU contention on MMIO reads. For AI sandbox workloads, 2 vCPUs is sufficient.

### 3.6. post_spawn() Trait Extension

**Rating: Good** -- CONFIRMED in v2.

Clean trait extension with backward-compatible default no-op (`sandbox/mod.rs:86-92`). `JobSandbox` overrides it for Job Object assignment. `CompositeSandbox` chains correctly (`composite.rs:72-77`). Full delegation chain verified: `ShimSpawner::spawn()` -> `Jailer::post_spawn()` -> `Sandbox::post_spawn()` -> `JobSandbox::post_spawn()` on Windows.

**[v2] Note**: `JobSandbox` tests (`post_spawn_without_setup_fails`, `post_spawn_assigns_to_job_object`) are gated behind `#[cfg(target_os = "windows")]`, creating a CI coverage gap on macOS/Linux runners.

---

## 4. Code Quality Review

### Important Issues (Should Fix)

#### I-1. DRY violation: transform_*_to_vsock functions are near-identical

**File**: `src/boxlite/src/vmm/krun/engine.rs:68-235`
**[v2] Status**: CONFIRMED

Two pairs of near-identical functions:
- `transform_shell_arg_unix_to_vsock` (lines 71-111) vs `transform_shell_arg_tcp_to_vsock` (lines 158-193)
- `transform_arg_unix_to_vsock` (lines 118-153) vs `transform_arg_tcp_to_vsock` (lines 200-235)

**[v2]** ~75 lines of duplicate logic (v1 said ~80; close). Each pair differs only in the scheme prefix (`"unix://"` vs `"tcp://"`). Could be reduced to a single parameterized function:

```rust
fn transform_shell_arg_scheme_to_vsock(
    input: &str, arg_name: &str, scheme: &str, vsock_port: u32
) -> String { ... }
```

#### I-2. Inconsistent cfg attribute usage

**[v2] Status**: PARTIALLY CORRECT -- counts corrected, core observation confirmed.

Three different cfg predicates used for "Windows code":

| Pattern | **[v2] Actual Count** | v1 Claim | Semantic |
|---------|----------------------|----------|----------|
| `#[cfg(windows)]` | **32** | ~20 | Windows-only |
| `#[cfg(not(unix))]` | **21** | ~15 | All non-Unix (broader) |
| `#[cfg(target_os = "windows")]` | **15** | ~25 | Windows-only (equivalent to `windows`) |

**[v2]** `#[cfg(windows)]` is actually the most common (32), not `#[cfg(target_os = "windows")]` as v1 claimed. The ordering was inverted.

Double-gating confirmed in `process.rs` (`kill_process` and `is_process_alive` wrap `#[cfg(target_os = "windows")]` inside `#[cfg(not(unix))]`) and `lock.rs` (same pattern). Defensive but verbose.

**Recommendation**: Standardize on `#[cfg(windows)]` (shorter, idiomatic) for Windows-only code, `#[cfg(unix)]` for Unix-only, and `#[cfg(not(unix))]` only where code genuinely applies to all non-Unix platforms.

#### I-3. Windows RuntimeLock::drop does NOT explicitly unlock

**File**: `src/boxlite/src/runtime/lock.rs:136-151`
**[v2] Status**: CONFIRMED

The Unix path explicitly unlocks (`libc::flock(fd, LOCK_UN)`) with comment "We explicitly unlock for clarity," but Windows has no corresponding `UnlockFileEx` call. Not a correctness bug (Windows releases locks on `CloseHandle` when the `File` field is dropped), but the comment's promise of explicit unlocking is only fulfilled on Unix.

#### I-4. SYNCHRONIZE constant hardcoded instead of imported

**File**: `src/boxlite/src/bin/shim/main.rs:441-443`
**[v2] Status**: CONFIRMED with context

```rust
// SYNCHRONIZE access right (0x00100000) -- stable Windows constant.
// Defined locally because windows-sys 0.61 moved it out of Threading.
const SYNCHRONIZE: u32 = 0x00100000;
```

**[v2]** The comment explains the workaround: `windows-sys 0.61` moved the constant out of `Win32::System::Threading`. The value is a Win32 ABI constant stable since Windows NT 3.1 and will never change. The same file imports `PROCESS_SYNCHRONIZE` from `windows_sys` where available (line 193), showing this is a targeted workaround, not carelessness. Severity is lower than v1 implied.

### Suggestions (Nice to Have)

| # | Issue | File | **[v2] Status** |
|---|-------|------|-----------------|
| S-1 | `ProcessMonitor::wait_for_exit` uses 500ms sleep polling (Rule #15: No Sleep for Events) | `process.rs:112-121` | CONFIRMED |
| S-2 | `#[allow(unreachable_code)]` in `shim.rs` stop() covers structurally unreachable `Ok(())` | `shim.rs:214` | CONFIRMED |
| S-3 | `JobSandbox` error messages lack Win32 error codes in `create_job_object()` | `job_object.rs:62,99` | CONFIRMED (2 of 3 error paths; `post_spawn()` does include them) |
| S-4 | `DiskFormat` cfg-gating repeated twice (minor DRY opportunity) | `vmm_spawn.rs:173,277` | CONFIRMED (exact same 4-line pattern) |
| S-5 | Missing test for `check_whpx_available` error paths | `system_check.rs:537-571` | CONFIRMED (all 4 error branches untested) |
| S-6 | `Keepalive::signal()` ignores `SetEvent` return value | `watchdog.rs:167-173` | CONFIRMED (also in `Drop` at line 182, but more defensible there) |

**[v2] New Code Quality Findings:**

| # | Issue | File | Severity |
|---|-------|------|----------|
| S-7 | `try_wait()` on Windows always returns `ProcessExit::Unknown` -- loses exit code info even though `GetExitCodeProcess` is available | `process.rs:99-107` | Suggestion |
| S-8 | `shim.rs` stop() uses `std::thread::sleep(50ms)` on Unix path -- blocks Tokio executor thread if called from async context | `shim.rs:123,184` | Suggestion |

### Test Coverage Assessment

| Module | Tests | Platform | Assessment |
|--------|-------|----------|------------|
| `job_object.rs` | 5 | Windows | Good **[v2]** (but CI gap: only runs on Windows) |
| `watchdog.rs` | 4 Win + 6 Unix | Both | Good |
| `port.rs` | 4 | Non-Unix | Good |
| `engine.rs` | 12 | Cross-platform | Good |
| `system_check.rs` | 2 Win + 3 other | Both | Adequate **[v2]** (error paths untested) |
| `process.rs` | 15+ | Both | Good |
| `guest_connect.rs` | 8 | Both | Good |
| `lock.rs` | 6 | Cross-platform | Good |
| `crash_capture.rs` (Windows exception handler) | 0 | Windows | Gap (hard to unit test) |
| `shim/main.rs` (Windows ctrl handler) | 0 | Windows | Gap (global state) |

**Overall**: Test gaps are concentrated in areas involving global process state (signal/exception handlers), which are covered by E2E tests.

---

## 5. Security Review

### Severity Summary

| Severity | **[v2] Count** | v1 Count | Change |
|----------|---------------|----------|--------|
| Critical | **0** | 1 | C-1 downgraded to High |
| High | **3** | 4 | H-2, H-3 downgraded to Medium |
| Medium | **7** | 5 | +H-2, +H-3, +NEW-1, +NEW-2; M-1, M-3 downgraded to Low |
| Low | **5** | 3 | +M-1, +M-3, +NEW-3 |
| Info | 2 | 2 | Unchanged |
| **Overall Risk** | **MEDIUM-HIGH** | HIGH | Severity rebalanced after code verification |

### High Issues **[v2]**

#### ~~C-1~~ H-1. TOCTOU Race in Job Object Assignment **[v2: downgraded CRITICAL -> HIGH]**

**Location**: `job_object.rs:129-162`, `spawn.rs:118-130`

The child process runs unrestricted between `cmd.spawn()` (line 119) and `AssignProcessToJobObject()` (line 151 in job_object.rs). During this window, the child can spawn grandchild processes outside the Job Object, consume unlimited memory, or become orphaned if the parent crashes.

On Linux, `pre_exec` hooks apply isolation atomically (post-fork, pre-exec). On Windows, there is no atomic mechanism.

**[v2] Downgrade rationale**: The spawned child is `boxlite-shim` -- a trusted binary, not user-controlled code. The user-controlled code runs inside the VM, which is started by the shim after it is already inside the Job Object. The TOCTOU window is real but the attack surface is limited: an attacker would need to replace or compromise the shim binary itself.

**Remediation**: Use `CREATE_SUSPENDED` flag via `CreateProcessW`, assign to Job Object before resuming. Requires custom spawn implementation since `std::process::Command` doesn't expose this.

#### H-2. TCP Localhost Transport Exposes VM Communication **[v2: renumbered from H-1]**

**Location**: `connection.rs:89-104`, `port.rs:37-51`, `engine.rs:561-600`

All three VM communication channels (gRPC, ready, network) use TCP on `127.0.0.1` with no authentication or TLS (`http://` scheme at `connection.rs:90`). Any local process can connect to the gRPC port and issue commands to the guest.

**[v2]** Port allocation in `port.rs:37-51` uses bind-release (allocate ephemeral port, release, hope no one takes it), which adds a small TOCTOU window for port hijacking.

On Unix, vsock/Unix domain sockets are kernel-mediated and permission-protected.

**Remediation options**:
1. Named Pipes (Windows) with ACLs
2. mTLS on gRPC with ephemeral certs
3. Per-box authentication tokens via stdin
4. Windows Unix domain sockets (Win10 1803+)

#### H-3. Debugfs Command Injection via Crafted OCI Layer Paths **[v2: renumbered from H-4]**

**Location**: `image_disk.rs` -- `fix_unicode_names_in_ext4()` (lines 665-691), `create_symlinks_in_ext4()` (lines 770-792), `fix_permissions_in_ext4()` (lines 858-861)

**[v2]** Three separate functions interpolate tar header paths into debugfs command strings:
```rust
commands.push_str(&format!("mkdir /{}\n", dir));                    // unicode
commands.push_str(&format!("symlink /{} {}\n", unix_path, target)); // symlinks
commands.push_str(&format!("sif /{} mode 0{:o}\n", unix_path, m)); // permissions
```

Path values originate from `entry.path()` (line 450) and `entry.header().link_name()` (line 502). A crafted tar entry with `\n` in the path injects arbitrary debugfs commands. Since debugfs runs with `-w` (writable), injected commands could modify files in the ext4 image.

**[v2]** Impact is limited to the guest ext4 image (not host filesystem), but a malicious OCI image could inject startup scripts or modify `/etc/passwd` in the guest.

**Remediation**: Sanitize all tar header paths before interpolation. Reject/escape newlines, quotes, backslashes.

### Medium Issues **[v2]**

| # | Issue | Location | **[v2] Notes** |
|---|-------|----------|----------------|
| M-1 | Missing UI restrictions on Job Object | `job_object.rs:58-105` | **[v2: was H-2, downgraded]** Breakaway is blocked by default (not setting `BREAKAWAY_OK` IS secure). But `JobObjectBasicUIRestrictions` and `DIE_ON_UNHANDLED_EXCEPTION` are genuinely missing. |
| M-2 | Watchdog Event Handle accessible via env var | `watchdog.rs:213-252` | **[v2: was H-3, downgraded]** Handle made inheritable (line 236), passed via `BOXLITE_SHUTDOWN_EVENT`. Exploiting requires existing local access to process environment -- standard pattern used by Docker/containerd. |
| M-3 | Missing Win32 error codes in Job Object creation | `job_object.rs:62,99` | CONFIRMED. Two of three error paths lack `last_os_error()`; `post_spawn()` does include it. |
| M-4 | Debugfs command files at predictable temp paths | `image_disk.rs:702-705, 795-798, 865-868` | CONFIRMED. Pattern: `boxlite-debugfs-{type}-{pid}.txt`. Fix: use `tempfile::NamedTempFile`. |
| M-5 | PID file written non-atomically on Windows | `spawn.rs:154-164` | CONFIRMED. `std::fs::write()` is not atomic. Fix: write-to-temp + rename. |
| M-6 | **[v2 NEW]** Inheritable handles leak to all child processes | `watchdog.rs:236`, `spawn.rs` | `SetHandleInformation(HANDLE_FLAG_INHERIT)` makes the event handle inheritable by ALL child processes, not just the shim. No `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` used to restrict. |
| M-7 | **[v2 NEW]** No TLS on gRPC connection (Windows-specific) | `connection.rs:90` | `http://` scheme means commands and potentially sensitive data are plaintext on a socket accessible to any local process. |

### Low Issues **[v2]**

| # | Issue | Location | **[v2] Notes** |
|---|-------|----------|----------------|
| L-1 | Symlink target validation (guest-only impact) | `image_disk.rs:502-513` | **[v2: was M-1, downgraded]** `unpack_in()` has built-in traversal protection for regular files. Symlink targets are guest-only. |
| L-2 | Memory limit cast `as usize` without overflow check | `job_object.rs:77` | **[v2: was M-3, downgraded]** Only affects 32-bit Windows (not targeted). On 64-bit, `u64 as usize` is lossless. |
| L-3 | Log level `RUST_LOG` forwarded to shim | `spawn.rs:170-176` | **[v2 NEW]** `RUST_LOG=debug` kills WHPX networking (documented in MEMORY.md). Attacker with env var access can DoS networking. |
| L-4 | Config JSON with secrets sent via stdin | `spawn.rs:111,138-143` | **[v2 NEW]** Comment states config contains CA private keys. On Windows, a privileged process could potentially attach to the stdin pipe. |
| L-5 | Secret zeroize / key lifecycle | Various | Unchanged from v1. |

### Windows Isolation Depth Comparison

| Layer | Linux | macOS | Windows |
|-------|-------|-------|---------|
| Filesystem isolation | Mount namespace + pivot_root | Seatbelt SBPL | **None** |
| Syscall filtering | seccomp-BPF | Seatbelt | **None** |
| Network isolation | Network namespace + Landlock | Seatbelt | **None** |
| Resource limits | cgroups v2 + rlimits | rlimits | Job Object (memory + process count) |
| Process isolation | PID namespace | N/A | Job Object kill-on-close |
| Transport | vsock (kernel-mediated) | vsock (kernel-mediated) | **TCP localhost (no auth, no TLS)** |
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

**Assessment: Well-designed** -- **[v2] PARTIALLY CORRECT** (detail refined)

The tiered approach (spin phase with `yield_now()`, then 200us sleep) is sound. **[v2]** The spin loop checks at `i % 10 == 9` (i=9,19,29,39,49), giving 5 checks as v1 stated. However, v1 omitted that each check also calls `tick_and_poll()` -- which ticks PIT, LAPIC timers, drains block I/O, and polls vsock/net. This is significant: the spin phase actively advances device state, not just checking for pending interrupts.

The observation about Windows timer resolution (15.625ms default) causing `std::thread::sleep(200us)` to actually sleep 1-15ms remains valid as a platform characteristic. **[v2]** A background timer thread (`runner.rs:339-347`) wakes all vCPUs every 1ms, which mitigates the worst case of prolonged HLT sleep.

### Area 2: LAPIC Timer Tick Throttle (skip if <500us elapsed)

**Assessment: Safe and appropriate** -- CONFIRMED in v2.

The 500us throttle gate (`manager.rs:690`: `if elapsed_ns > 500_000`) controls **only** `tick_timer()` calls (interrupt delivery). CCR reads (`lapic.rs:278`: `0x390 => self.current_count()`) are serviced immediately on every `VcpuExit::MmioRead` -- no throttle. The `current_count()` method computes remaining ticks from `Instant::now()` vs `timer_deadline`, independent of `tick_timer()`.

This distinction is critical for timer calibration: the kernel busy-loops reading CCR, which works correctly because MMIO reads are unthrottled. Timer interrupt delivery latency of up to 500us on a 10ms period is negligible.

### Area 3: Warm Exec Gap Root Cause

**Root cause: Raw disk copy on Windows vs QCOW2 COW on Unix** -- CONFIRMED in v2.

| Platform | Mechanism | Disk Copy Time |
|----------|-----------|----------------|
| macOS/Linux | QCOW2 COW child disk (512-byte header) | ~1ms |
| Win11 (NVMe) | `std::fs::copy()` ~256MB | ~3-4ms |
| Win10 (SATA) | `std::fs::copy()` ~256MB | ~35-40ms |

**[v2]** Code evidence:
- Windows: `container_rootfs.rs:253-273` -- `std::fs::copy(base_disk_path, &disk_path)`
- Unix: `container_rootfs.rs:275-289` -- `Qcow2Helper::create_cow_child_disk()`

The Win10 vs Win11 gap (47.7ms vs 6.5ms) is almost entirely storage hardware: SATA SSD (500MB/s) vs NVMe SSD (3000+ MB/s).

**[v2] NEW**: There is a **second** full disk copy for the guest rootfs disk (`guest_rootfs.rs:164`: `std::fs::copy(base_disk_path, &guest_rootfs_disk_path)`). The v1 report only discussed the container disk copy. On Windows, each box creation may involve two full disk copies, compounding the warm exec overhead.

### Area 4: 2-vCPU Cap (DeviceManager Mutex Contention)

**Root cause**: CONFIRMED in v2.

All devices behind single `Arc<Mutex<DeviceManager>>` (`runner.rs:314`). **[v2]** 17 `devices.lock().unwrap()` call sites confirmed in `runner.rs`. The LAPICs are already per-vCPU data structures, but accessed through the shared mutex. Fix direction: move LAPICs outside the DeviceManager mutex into per-vCPU locks, split MMIO dispatch for LAPIC addresses.

### Area 5: TCP Transport Overhead

**[v2] Status**: PARTIALLY CORRECT (detail clarified)

**[v2]** `TCP_NODELAY` is set on the **vsock device TCP connections** (`vsock/mod.rs:268-269,386-387`), which handle the gRPC transport path. It is NOT set on the virtio-net `TcpTransport` (`net.rs:115-123`), which only sets `set_nonblocking(true)`. The v1 report's claim that "TCP loopback with TCP_NODELAY" is used is correct for gRPC but misleading for the net transport.

TCP overhead remains a minor contributor (~0.5-1ms per gRPC call) relative to disk copy cost.

### Top 3 Performance Improvement Opportunities

| Rank | Improvement | Impact | Risk | **[v2] Notes** |
|------|------------|--------|------|----------------|
| **1** | Disk copy elimination (reflink or QCOW2 COW) | -40ms Win10, -4ms Win11 | Low-High | **[v2]** Two disk copies per box (container + guest rootfs), not just one. Reflink only works on ReFS/DevDrive, not production NTFS. |
| **2** | Per-vCPU LAPIC locking (remove 2-vCPU cap) | Enables 4+ vCPUs, 30-50% throughput | Medium | CONFIRMED |
| **3** | HLT sleep resolution (`timeBeginPeriod` + WaitableTimer) | -1-2ms latency, better responsiveness | Low | **[v2]** Impact may be less than stated; timer thread already wakes vCPUs every 1ms, mitigating worst case. |

#### Rank 1 Detail: Disk Copy Elimination

**Option A (simplest)**: Windows reflink via `FSCTL_DUPLICATE_EXTENTS_TO_FILE`. Works on ReFS/DevDrive. Falls back to `std::fs::copy()` if unsupported. **[v2]** Does NOT work on standard NTFS, limiting applicability.

**Option B (moderate)**: Sparse file + lazy copy.

**Option C (complex)**: QCOW2 block driver in WHPX VMM. Most complete but requires adding qcow2 read support to the virtio-blk backend.

---

## 7. Consolidated Findings

### By Priority **[v2]**

| Priority | Category | Count | Key Items |
|----------|----------|-------|-----------|
| **P1 (High)** | Security | 3 | TOCTOU in Job Object (H-1), TCP no auth (H-2), debugfs injection (H-3) |
| **P1 (High)** | Performance | 1 | Disk copy bottleneck (47.7ms on Win10) |
| **P2 (Medium)** | Security | 7 | Job Object UI gaps (M-1), watchdog handle (M-2), error codes (M-3), temp files (M-4), PID file (M-5), handle leaks (M-6), no TLS (M-7) |
| **P2 (Medium)** | Code Quality | 4 | DRY violation (I-1), cfg inconsistency (I-2), lock asymmetry (I-3), hardcoded constant (I-4) |
| **P3 (Low)** | Performance | 2 | Per-vCPU LAPIC locking, HLT sleep resolution |
| **P3 (Low)** | Code Quality | 8 | S-1 through S-8 |
| **P3 (Low)** | Security | 5 | Symlink targets (L-1), memory cast (L-2), RUST_LOG (L-3), stdin secrets (L-4), zeroize (L-5) |

### What Was Done Well

1. **Excellent architectural decisions** -- reuses existing Unix patterns without imposing Windows-specific abstractions on shared code
2. **Proper abstraction boundaries** -- `PlatformSandbox` type alias, `post_spawn()` trait extension, `NetworkBackendEndpoint` enum variant
3. **Strong error messages** -- almost every Windows API call includes `std::io::Error::last_os_error()` context (with 2 exceptions in `create_job_object`)
4. **Thorough E2E validation** -- tested on real Win10 and Win11 hardware, BrowserBox verified
5. **Good test coverage** -- 521 unit tests on Windows, 13 functional + 8 network + 5 stability E2E tests
6. **Documentation quality** -- module-level doc comments explain both what and why; root cause comments on key limitations (vCPU cap, SYNCHRONIZE workaround)

**[v2] Additional strengths identified:**
- Correct use of secure defaults: Job Object breakaway prevention works by NOT setting the `BREAKAWAY_OK` flag
- `post_spawn()` trait design is backward-compatible and correctly chained through `CompositeSandbox`
- `ProcessMonitor` event-driven wait pattern (`WaitForSingleObject`) exists in `shim.rs stop()`, showing the codebase has the right patterns available even where `wait_for_exit()` uses polling

---

## 8. Improvement Roadmap **[v2]**

### Phase 1: Security Hardening (Before Production)

| Item | **[v2] Priority** | v1 Priority |
|------|-------------------|-------------|
| H-1: `CREATE_SUSPENDED` spawn pattern | P1 | P0 |
| H-2: Per-box auth tokens on gRPC channel | P1 | P1 |
| H-3: Debugfs path sanitization | P1 | P1 |
| M-1: Job Object UI restrictions + `DIE_ON_UNHANDLED_EXCEPTION` | P2 | P1 |
| M-3: Win32 error codes in all error paths | P2 | P2 |
| M-4: Use `tempfile::NamedTempFile` for debugfs commands | P2 | P2 |
| M-6: Restrict inheritable handles (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`) | P2 | N/A (new) |

### Phase 2: Performance Optimization

| Item | Priority |
|------|----------|
| Disk copy elimination (both container + guest rootfs) | P1 |
| `timeBeginPeriod(1)` + WaitableTimer | P3 |
| Per-vCPU LAPIC locking (4+ vCPU support) | P3 |

### Phase 3: Code Quality Polish

| Item | Priority |
|------|----------|
| I-1: Refactor `transform_*_to_vsock` (DRY) | P2 |
| I-2: Standardize cfg attribute convention | P2 |
| I-3: Symmetric lock/unlock in `RuntimeLock` | P2 |
| I-4: Import or document `SYNCHRONIZE` constant | P3 |
| S-7: Windows `try_wait()` should capture exit codes | P3 |

---

## Appendix: v1 -> v2 Verification Matrix

| v1 Finding | v2 Verdict | Severity Change | Key Correction |
|------------|-----------|-----------------|----------------|
| **Architecture** | | | |
| 3.1 Shim Model | PARTIALLY CORRECT | -- | "Minimal" -> "moderate" branching; ~40 cfg blocks in ~15 files |
| 3.2 Platform Abstraction | CONFIRMED | -- | -- |
| 3.3 TCP Transport | CONFIRMED | -- | -- |
| 3.4 Interrupt Architecture | PARTIALLY CORRECT | -- | Files under `windows/devices/`, not `windows/`; total 39 VMM files |
| 3.5 Multi-vCPU Cap | CONFIRMED | -- | 17 lock sites confirmed |
| 3.6 post_spawn() | CONFIRMED | -- | CI coverage gap noted |
| **Code Quality** | | | |
| I-1 DRY transform | CONFIRMED | -- | ~75 lines (was ~80) |
| I-2 cfg inconsistency | PARTIALLY CORRECT | -- | `#[cfg(windows)]` most common (32), not `target_os` (15) |
| I-3 RuntimeLock | CONFIRMED | -- | -- |
| I-4 SYNCHRONIZE | CONFIRMED | -- | Documented workaround, lower severity than implied |
| S-1 through S-6 | ALL CONFIRMED | -- | S-3: 2 of 3 error paths (not all) |
| **Security** | | | |
| C-1 TOCTOU | CONFIRMED | CRITICAL -> **HIGH** | Child is trusted shim, not user code |
| H-1 TCP transport | CONFIRMED | HIGH | -- |
| H-2 Job Object gaps | PARTIALLY CORRECT | HIGH -> **MEDIUM** | Breakaway IS blocked by default |
| H-3 Watchdog handle | CONFIRMED | HIGH -> **MEDIUM** | Requires existing local access |
| H-4 Debugfs injection | CONFIRMED | HIGH | 3 injection sites confirmed |
| M-1 Path traversal | PARTIALLY CORRECT | MEDIUM -> **LOW** | `unpack_in()` IS protected; symlinks guest-only |
| M-2 Error codes | CONFIRMED | MEDIUM | -- |
| M-3 Memory cast | CONFIRMED | MEDIUM -> **LOW** | Only 32-bit, not targeted |
| M-4 Temp paths | CONFIRMED | MEDIUM | -- |
| M-5 PID file | CONFIRMED | MEDIUM | -- |
| **Performance** | | | |
| Area 1 HLT | PARTIALLY CORRECT | -- | Spin also calls `tick_and_poll()`, not just IRQ check |
| Area 2 LAPIC throttle | CONFIRMED | -- | -- |
| Area 3 Warm exec | CONFIRMED | -- | Second disk copy (guest rootfs) missed in v1 |
| Area 4 vCPU cap | CONFIRMED | -- | -- |
| Area 5 TCP overhead | PARTIALLY CORRECT | -- | TCP_NODELAY on vsock TCP, not net transport |

---

*Report v2 generated by 4 specialized review agents, each cross-checking v1 findings against source code.*
*Total files examined: 42+ source files across `src/boxlite/` and `src/deps/libkrun-sys/vendor/`.*
*v1 date: 2026-04-30. v2 date: 2026-04-30.*
