# Windows WHPX 4-vCPU Support: Decision, Development & Lessons

## 1. Problem Statement

BoxLite's Windows WHPX VMM was capped at 2 vCPUs since Iter 3 (Multi-vCPU). At 3+ vCPUs, the BSP (Bootstrap Processor) would hang during early Linux boot — zero console output, no block I/O, kernel never prints. The guest appeared completely stuck.

**Impact**: Users on 4+ core Windows machines couldn't leverage their hardware. The 2-vCPU cap was a significant production limitation for workloads that benefit from parallelism.

## 2. Solution Decision

### Approach: Software LAPIC with ICR Shorthand Fix

**Chosen**: Keep the existing software LAPIC emulation (user-space MMIO interception) and fix the IPI routing bug.

**Rejected alternative**: Switch to WHPX native APIC emulation (`WHvX64LocalApicEmulationModeXApic`). This would have WHPX handle all LAPIC logic in-kernel, eliminating MMIO exits entirely. Rejected because:
- Requires significant architectural rewrite (remove entire LAPIC/IOAPIC emulation layer)
- Win10 MBP 2014 crashes with native APIC emulation (hardware limitation)
- Less control over interrupt delivery timing and diagnostics
- Our software LAPIC already works well at 2 vCPUs — the issue was a missing feature, not a design flaw

### Reference Solutions Studied

| Project | APIC Approach | Multi-vCPU Strategy |
|---------|--------------|---------------------|
| **QEMU/WHPX** | `WHvX64LocalApicEmulationModeXApic` (native) | Hyper-V handles all IPI routing in-kernel |
| **OpenVMM** | Software LAPIC with `SharedState` | Lock-free `new_irr` atomic array for cross-vCPU interrupt delivery |
| **crosvm** | KVM in-kernel APIC | N/A for WHPX |
| **Our approach** | Software LAPIC + SharedApicState (inspired by OpenVMM) | Lock-free atomic OR for interrupt delivery, ICR shorthand parsing |

Key insight from OpenVMM: per-vCPU `SharedApicState` with atomic `new_irr` banks eliminates cross-vCPU locking. We adopted this pattern in Iter 7.

## 3. Development & Fix Roadmap

### Phase 1: Foundation (Iter 3, completed earlier)

- Multi-vCPU scaffolding: `std::thread::scope` for AP threads
- INIT-SIPI-SIPI protocol for AP startup via condvar signaling
- AP register initialization (real mode → protected → long mode transition)
- vCPU cap set to 2 (worked at 2, hung at 3+)

### Phase 2: Lock-Free LAPIC (Iter 7)

- **Problem**: Mutex-based LAPIC caused contention at 2+ vCPUs
- **Solution**: `SharedApicState` with `[AtomicU32; 8]` for 256-bit IRR
- **Key pattern**: Source vCPU atomically ORs vector bit → target vCPU calls `pull_irr()` to merge
- **Critical lesson**: `pull_irr()` must happen AFTER `tick_and_poll()` too — device interrupts raised during polling go to SharedApicState
- **Result**: Stable at 2 vCPUs, BSP hang persists at 4

### Phase 3: Investigation (Iter 8, E2E #122-#128)

#### Hypothesis 1: Timer Cancel Storm (REJECTED)

**Theory**: Timer thread calling `WHvCancelRunVirtualProcessor` on non-running APs corrupts WHPX state.

**Implementation**: Added `vcpu_running: Vec<Arc<AtomicBool>>` flags. Timer only cancels vCPUs that have entered `WHvRunVirtualProcessor`.

**Result**: Did NOT fix the hang. E2E #126-#127 still failed at 4 vCPUs. However, the guard is kept as a correctness improvement.

#### Hypothesis 2: CPUID Topology (PARTIALLY CORRECT)

**Theory**: Incorrect CPUID leaf 0xB/0x1F/4 responses confuse kernel's topology parser.

**Implementation**: `handle_cpuid()` intercepts topology leaves, returns correct `num_vcpus` and per-level topology information.

**Critical sub-bug found**: `VcpuExit::CpuidAccess` has TWO ECX fields — `rcx` (guest INPUT sub-leaf) and `default_rcx` (WHPX OUTPUT result). Using `default_rcx` for sub-leaf extraction broke the topology loop.

**Result**: Fixed an infinite loop at `parse_topology_leaf` (RIP=0xFFFFFFFF81027E80), but hang persisted at a different RIP after this fix. Required but not sufficient.

#### Hypothesis 3: AP Diagnostic Gap (DIAGNOSTIC IMPROVEMENT)

**Problem**: After initial 10 exits were logged, APs went "silent" — no visibility into their state.

**Implementation**: Added periodic AP progress logging (every 500 Cancelled exits), tracking `cancelled_count`, `cpuid_count`, total halt/mmio exits, and RIP.

**Revelation** (E2E #128): APs are ALIVE at RIP=0xFFFFFFFF81990D3B (kernel idle loop), producing ~2000 exits/second (halt + cancelled + mmio). They completed trampoline + long mode transition successfully. BSP at RIP=0xFFFFFFFF810E7335 spinning in SMP wait loop.

**Key insight**: APs are in kernel idle — they never received the "proceed" IPI from BSP.

#### Hypothesis 4: ICR Destination Shorthand (ROOT CAUSE FOUND)

**Theory**: `parse_icr()` doesn't handle ICR Low bits 19:18 (destination shorthand). Linux uses "All Excluding Self" (0b11) for broadcast IPI.

**Evidence**:
- BSP spin-waiting means it sent the wakeup IPI but APs didn't respond
- At 2 vCPUs: only 1 AP, so even single-target dispatch (from ICR High) reaches it
- At 3+: kernel broadcasts to ALL APs using shorthand, but we only send to ICR High target

**Verification**: E2E #129 — vm-bench 8/8 PASS (cpus=1), net-test 8/8 PASS (cpus=4).

### Phase 4: The Fix

```rust
// BEFORE (broken): Only extracted single target, ignored shorthand
fn parse_icr(&self) -> IpiAction {
    let dest_apic_id = ((self.icr_high >> 24) & 0xFF) as u8;
    // Always sent to ONE target regardless of shorthand bits
    IpiAction::SendInterrupt { target_apic_id: dest_apic_id, vector }
}

// AFTER (fixed): Parse shorthand first, broadcast when needed
fn parse_icr(&self) -> IpiAction {
    let dest_shorthand = (self.icr_low >> 18) & 0x3;
    match dest_shorthand {
        0b01 => IpiAction::SendInterrupt { target: self.id, vector },  // Self
        0b10 | 0b11 => IpiAction::BroadcastInterrupt { source: self.id, vector },
        _ => /* normal single-target path */
    }
}
```

Dispatch in BSP/AP fast paths:
```rust
IpiAction::BroadcastInterrupt { source_apic_id, vector } => {
    for idx in 0..all_shared.len() {
        if idx as u8 != source_apic_id {
            all_shared[idx].request_interrupt(vector);
            cancellers[idx].cancel();
        }
    }
}
```

## 4. Testing Methodology

### E2E Test Matrix

| Test | vCPUs | Purpose |
|------|-------|---------|
| vm-bench | 1 (explicit) | Regression: single-vCPU cold/warm exec |
| net-test | 4 (default) | Multi-vCPU: full networking stack (eth0, IP, DNS, HTTP/HTTPS) |

### Diagnostic Evolution

| E2E # | Diagnostics Added | Finding |
|--------|-------------------|---------|
| #122 | Bisection (Iter 7 alone) | Lock-free LAPIC works at 2 vCPUs |
| #123 | CPUID leaf 0xB interception | `default_rcx` vs `rcx` sub-bug |
| #124 | CPUID fix verified | Topology fixed, hang persists |
| #125 | 2-vCPU regression check | Clean at cpus=2 |
| #126 | Timer cancel guard | Guard works but hang persists |
| #127 | BSP periodic diag (diag! macro) | BSP RIP=0xFFFFFFFF810E7335, APs silent after CPUID |
| #128 | AP periodic RIP + stats | APs alive at idle loop, never received wakeup IPI |
| #129 | ICR shorthand fix | **8/8 PASS at 4 vCPUs** |

### Key Testing Principle

**Diagnostic-first approach**: Each failed E2E added instrumentation for the NEXT hypothesis. Never tried to fix blindly — always gathered evidence first to narrow the root cause.

## 5. Key Lessons Learned

### Architecture Lessons

1. **x86 LAPIC ICR has 4 destination shorthands** — any software LAPIC MUST handle all of them:
   - `0b00`: No shorthand (use destination field in ICR High)
   - `0b01`: Self
   - `0b10`: All Including Self
   - `0b11`: All Excluding Self (Linux uses this for broadcast IPI)

2. **"Works at N but fails at N+1" often means routing/broadcast bugs** — if a unicast path works but multi-target fails, check for missing broadcast/multicast handling.

3. **2 vCPUs is a degenerate case** — with only 1 AP, unicast and broadcast are equivalent. Always test at 3+ vCPUs to find routing bugs.

### Debugging Lessons

4. **`log::info!` from VMM doesn't reach the shim's tracing subscriber** — the shim uses `tracing-appender` which doesn't capture `log` crate output from libkrun. Use `diag!()` macro (direct file write to `%TEMP%\whpx-diag.log`) for VMM diagnostics.

5. **`VcpuExit::CpuidAccess` has TWO ECX fields** — `rcx` is guest INPUT (sub-leaf number), `default_rcx` is WHPX's computed OUTPUT. Using the wrong one breaks topology enumeration.

6. **"Silent" doesn't mean "dead"** — APs appeared to go silent after 10 CPUID exits, but periodic RIP logging revealed they were actively running (2000+ exits/sec) in kernel idle. The issue was upstream (missing IPI), not local (AP crash).

7. **BSP spinning + APs idle = missing IPI** — this pattern is diagnostic: BSP is waiting for APs to "check in", APs are waiting for a wakeup signal. The signal path is broken.

### Process Lessons

8. **Timer cancel guard was correct but not the root cause** — defensive improvements are worth keeping even when they don't fix the target bug. The guard prevents undefined behavior when cancelling non-running vCPUs.

9. **Bisection narrows but doesn't always solve** — E2E #122 proved lock-free LAPIC wasn't the regression, but the real bug existed since Iter 3 (masked by 2-vCPU cap).

10. **Each failed hypothesis provides signal** — timer cancel (not it), CPUID topology (partial), AP diagnostics (reveals idle state) → ICR shorthand (root cause). The path wasn't linear but each step narrowed the search space.

## 6. Final State

| Metric | Before (Iter 7) | After (Iter 8) |
|--------|-----------------|----------------|
| Max vCPUs | 2 | 4 |
| vm-bench (cpus=1) | 8/8 PASS | 8/8 PASS |
| net-test (cpus=4) | FAIL (hang) | 8/8 PASS |
| IPI routing | Unicast only | Unicast + Broadcast |
| Diagnostic coverage | BSP only | BSP + all APs periodic |

### Files Modified

| File | Change |
|------|--------|
| `vendor/libkrun/src/vmm/src/windows/devices/lapic.rs` | `BroadcastInterrupt` enum variant, ICR shorthand parsing in `parse_icr()` |
| `vendor/libkrun/src/vmm/src/windows/runner.rs` | Broadcast dispatch in BSP/AP fast paths, `dispatch_ipi()`, AP diagnostics, timer cancel guard |
| `src/boxlite/src/vmm/krun/engine.rs` | vCPU cap: `clamp(1, 2)` → `clamp(1, 4)` |
