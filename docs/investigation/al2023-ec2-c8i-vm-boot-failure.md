# Root Cause Analysis: BoxLite VM Failure on Amazon Linux 2023 (EC2 c8i)

## Summary

BoxLite VMs fail to start on Amazon Linux 2023 (kernel 6.1) on EC2 c8i instances. The guest kernel (Linux 6.12.62, embedded in libkrunfw) triggers an i8042 CPU reset during early boot, causing immediate VM termination with no error output.

## Environment

| Component | Working (Ubuntu) | Failing (AL2023) |
|-----------|-----------------|------------------|
| Host OS | Ubuntu 24.04 | Amazon Linux 2023 |
| Host kernel | 6.17.0-1007-aws | 6.1.164-196.303.amzn2023 |
| Instance type | c8i.4xlarge | c8i.4xlarge |
| Instance ID | i-0a2516cdf06c221df (boxlite-prod) | i-095ae61ecbca0d780 (boxlite-dev) |
| Nested KVM | Yes | Yes |
| KVM capabilities | ept, vpid, unrestricted_guest | Identical |
| Guest kernel | 6.12.62 (libkrunfw v5.1.0) | 6.12.62 (libkrunfw v5.1.0) |

## Root Cause

The guest kernel (Linux 6.12.62) issues a **hardware reset via the i8042 keyboard controller** during very early boot when running under nested KVM on host kernel 6.1.

### Shutdown sequence

```
1. krun_start_enter() called
2. VMM creates VM, sets up virtio devices (CMOS, balloon, rng, console, fs, block, vsock, net)
3. 8 vCPUs started in paused state, then resumed
4. Boot vCPU (vCPU0) runs ~5 KVM_RUN iterations (I/O handling)
5. Guest kernel writes CMD_RESET_CPU (0xFE) to i8042 port 0x64
   → i8042 device handler writes to reset_evt EventFd
6. VMM event loop receives reset_evt, calls libc::_exit(0)
7. All threads killed instantly — no console output, no error messages
```

### Why the original diagnosis was wrong

PR #417 diagnosed this as "broken nested KVM on EC2 c8i / Amazon Linux 2023" based on a flawed KVM smoke test. The smoke test didn't initialize vCPU registers (CS:IP, RFLAGS) before KVM_RUN, causing it to fail on any nested KVM. This was fixed in PR #421.

KVM itself works correctly on both kernels — the issue is that the **guest kernel** (libkrunfw 6.12.62) can't boot under kernel 6.1's nested KVM emulation.

## Diagnosis Process

### Step 1: Verify KVM works

Wrote a C program (`kvm_test.c`) that creates a minimal VM with a HLT instruction and proper vCPU register init (CS base=0, RIP=0, RFLAGS=0x2).

```
# AL2023 (kernel 6.1)
WITH register setup: exit_reason=5 (HLT) ✅
WITHOUT register setup: exit_reason=17 (SHUTDOWN) ❌

# Ubuntu 24.04 (kernel 6.17)
WITH register setup: exit_reason=5 (HLT) ✅
WITHOUT register setup: exit_reason=0 (UNKNOWN) ❌
```

**Conclusion:** KVM works on both. The smoke test was broken, not KVM.

### Step 2: Compare KVM capabilities

Used `KVM_CHECK_EXTENSION` ioctl via Python to compare capabilities:

```
# Both kernels — identical results:
IRQCHIP(1)=1, HLT(2)=1, USER_MEMORY(4)=1, SET_TSS_ADDR(6)=1
VAPIC(13)=0, EXT_CPUID(14)=1, INTERNAL_ERROR_DATA(25)=4096
TSC_CONTROL(28)=0, SET_BOOT_CPU_ID(37)=1, X86_DISABLE_EXITS(41)=1
SPLIT_IRQCHIP(117)=1, IMMEDIATE_EXIT(119)=0, VMX_EXCEPTION_PAYLOAD(129)=3

CPU flags (both): vmx, ept, vpid, unrestricted_guest, tpr_shadow, vnmi, flexpriority
Nested virt: Y (both)
```

**Conclusion:** KVM capabilities are identical. The difference is not in feature exposure.

### Step 3: Run BoxLite with debug logging

Built boxlite-cli on AL2023 and ran with `RUST_LOG=trace`:

```
[shim] T+0ms: main() entered
[shim] T+5ms: config parsed
[shim] T+9ms: logging initialized
[shim] T+83ms: gvproxy created
[shim] T+83ms: engine created
[shim] T+92ms: instance created (krun FFI calls done)
[shim] T+93ms: entering VM (krun_start_enter)
[krun] krun_start_enter called
[DEBUG vmm] using vcpu exit code: 0
[INFO  vmm] Vmm is stopping.
```

**Observations:**
- Shim starts fine, all FFI calls succeed
- Virtio devices set up: `set_irq_line: 5-13` (balloon, rng, console, fs×2, block×2, vsock, net)
- VMM stops with exit code 0 (clean shutdown)
- Console output: completely empty
- No `KVM_EXIT_HLT`, `SHUTDOWN`, `FAIL_ENTRY`, or `INTERNAL_ERROR` observed

### Step 4: Instrument libkrun vCPU run loop

Added `eprintln!("[krun-debug] vCPU run loop iteration {n}")` to the `running()` function in `vmm/src/linux/vstate.rs`. Required rebuilding libkrun from vendored source (not the prebuilt binary):

```bash
# Must delete libkrun's own target directory to force rebuild
rm -rf src/deps/libkrun-sys/vendor/libkrun/target/
make shim  # triggers full rebuild
```

**Result:**
```
[krun-debug] vCPU run loop iteration 1   # ×8 (one per vCPU)
[krun-debug] vCPU run loop iteration 2   # boot vCPU only
[krun-debug] vCPU run loop iteration 3
[krun-debug] vCPU run loop iteration 4
[krun-debug] vCPU run loop iteration 5
```

Boot vCPU runs exactly 5 KVM_RUN iterations. Other 7 vCPUs run 1 each.

### Step 5: Instrument KVM exit handlers

Added `eprintln` and `std::fs::write("/tmp/krun-vcpu-*.log")` to every `VcpuExit` handler: HLT, Shutdown, SystemEvent, FailEntry, InternalError, and the `Stopped`/`Error` catch in `running()`.

**Result:** None of them fired. No files written. No exit handler triggered.

Verified strings are in the deployed binary:
```bash
$ strings ~/.local/share/boxlite/runtimes/v0.8.0-*/boxlite-shim | grep 'krun-debug'
[krun-debug] KVM_EXIT_HLT
[krun-debug] KVM_EXIT_SHUTDOWN
[krun-debug] KVM_SYSTEM_EVENT: event=
[krun-debug] vCPU STOPPED at iteration
...
```

**Conclusion:** The vCPU exits through `Interrupted` (EINTR) → channel disconnected, not through any KVM exit handler. Something external triggers the shutdown.

### Step 6: Instrument i8042 device handler

Found in `libkrun/src/devices/src/legacy/i8042.rs:229-236`:
```rust
OFS_STATUS if data[0] == CMD_RESET_CPU => {
    // The guest wants to assert the CPU reset line.
    if let Err(e) = self.reset_evt.write(1) { ... }
}
```

Added instrumentation:
```rust
let _ = std::fs::write("/tmp/krun-i8042-reset.log",
    "i8042: CMD_RESET_CPU triggered by guest kernel\n");
eprintln!("[krun-debug] i8042: CMD_RESET_CPU - guest requested reset!");
```

**Result:**
```
$ cat /tmp/krun-i8042-reset.log
i8042: CMD_RESET_CPU triggered by guest kernel

$ grep krun-debug shim.stderr
[krun-debug] vCPU run loop iteration 1   # ×8
[krun-debug] vCPU run loop iteration 2
[krun-debug] i8042: CMD_RESET_CPU - guest requested reset!   # ← HERE
[krun-debug] vCPU run loop iteration 3
[krun-debug] vCPU run loop iteration 4
[krun-debug] i8042: CMD_RESET_CPU - guest requested reset!   # ← RETRY
[krun-debug] vCPU run loop iteration 5
```

**Root cause confirmed:** The guest kernel triggers CMD_RESET_CPU via i8042 port 0x64 at iteration 2, retries at iteration 4. The i8042 handler writes to `reset_evt` EventFd → VMM event loop calls `_exit(0)`.

### Step 7: Capture all I/O operations

Added `eprintln` to IoIn, IoOut, MmioRead, MmioWrite handlers. Also modified `DEFAULT_KERNEL_CMDLINE` to remove `quiet` and add `earlyprintk=hvc0 panic=5 panic_print=15`.

**Complete I/O trace of the failed boot:**
```
vCPU run loop iteration 1   # ×8 (one per vCPU, likely HLT/interrupt)
IoIn  port=0x64 len=1       # Read i8042 status register
IoOut port=0x64 data=[254]  # Write 0xFE = CMD_RESET_CPU (first reset attempt)
i8042: CMD_RESET_CPU
IoIn  port=0x64 len=1       # Read status again (retry)
IoOut port=0x64 data=[254]  # Write 0xFE again (second reset attempt)
i8042: CMD_RESET_CPU
```

**Key observation:** The guest kernel performs ZERO other I/O operations — no serial port writes, no MMIO, no CMOS, no PIC/APIC, no PCI. It goes directly from initial execution to i8042 reset. This means the failure happens during **kernel decompression or very early startup** (before any hardware probing).

The `earlyprintk=hvc0` and removal of `quiet` had no effect — console output remained empty because the crash occurs before the console driver is even initialized.

### Step 8: Analysis of the failure point

The kernel cmdline includes `reboot=k` which tells Linux to reboot via keyboard controller. Combined with `panic=-1` (immediate reboot on panic), the sequence is:
1. Guest kernel starts decompression / early init
2. Triple fault or early boot error (before any console output)
3. CPU reset → i8042 CMD_RESET_CPU (0xFE) on port 0x64
4. VMM `_exit(0)`

The triple fault likely occurs because kernel 6.1's nested KVM doesn't properly emulate a CPU feature that the guest kernel 6.12.62 requires during very early boot (decompressor or head_64.S code).

### Further investigation needed

To determine the exact CPU feature causing the triple fault:
1. Use `perf kvm stat` on the host to capture VM entry/exit reasons
2. Try an older libkrunfw guest kernel (e.g., 5.15 or 6.1) to see if it boots
3. Compare CPUID leaves between kernel 6.1 and 6.17 nested KVM using a test program

## Why kernel 6.1 vs 6.17

KVM capabilities are identical between both kernels (verified via `KVM_CHECK_EXTENSION`). The difference is likely in:

1. **CPUID emulation**: Kernel 6.1 may not expose certain CPUID leaves that the guest kernel 6.12.62 requires (e.g., newer Intel features like CET, WAITPKG, AMX)
2. **MSR handling**: Certain MSRs may not be properly emulated under nested KVM in 6.1
3. **VMX feature bits**: The nested VMX VMCS may not advertise features the guest kernel expects

The guest kernel hits an early boot failure (likely during CPU feature detection or APIC setup), determines it can't continue, and uses the i8042 reset as the fallback shutdown mechanism.

## Recommendations

### For libkrun/libkrunfw

1. **Add early console output**: The guest kernel should print to the virtio console before reaching the point where it would trigger a reset. Adding `earlyprintk=hvc0` or similar to the kernel command line would capture the actual error.

2. **Consider a more compatible guest kernel**: libkrunfw uses kernel 6.12.62 which may require features not available in kernel 6.1's nested KVM. Testing with an older guest kernel (e.g., 5.15 or 6.1) could work.

3. **Don't silently _exit on i8042 reset**: Instead of calling `_exit(0)`, the VMM should log a clear error: "Guest kernel triggered hardware reset (i8042 CMD_RESET_CPU). The guest kernel may be incompatible with this KVM configuration."

### For BoxLite users

1. **Use Ubuntu 24.04** (kernel 6.17) instead of Amazon Linux 2023 for EC2 instances
2. **Or upgrade AL2023 kernel** to a newer version if available
3. **Or use bare-metal instances** (.metal) which don't have nested KVM limitations

## Files involved

| File | Role |
|------|------|
| `libkrun/src/devices/src/legacy/i8042.rs:229-236` | i8042 CMD_RESET_CPU handler triggers VM exit |
| `libkrun/src/vmm/src/lib.rs:403-428` | VMM event handler calls _exit(0) on reset_evt |
| `libkrun/src/vmm/src/linux/vstate.rs:1421-1590` | vCPU run_emulation() and running() state machine |
| `libkrun/src/libkrun/src/lib.rs:2684-2688` | VMM event loop in krun_start_enter |

## Upstream Status

No existing upstream issues or fixes found for running libkrun on a nested KVM host (our scenario: EC2 L0 → KVM L1 → libkrun L2). This appears to be an unreported configuration.

Note: [libkrunfw#50](https://github.com/containers/libkrunfw/issues/50) is about a *different* thing — enabling nested KVM *inside* libkrun guest VMs, not about running libkrun on top of nested KVM.

Relevant references:
- [libkrun#460](https://github.com/containers/libkrun/issues/460) — Silent reset with low memory (fixed in v1.17.0, similar symptom)
- [libkrun#314](https://github.com/containers/libkrun/issues/314) — ENOMEM on kernel 6.12/6.13 host (different issue)
- [libkrun#302](https://github.com/containers/libkrun/pull/302) — KVM SystemEvents support (aarch64 only)

BoxLite works on Ubuntu 24.04 (kernel 6.17) on the same EC2 c8i hardware because the newer kernel provides better nested KVM emulation that satisfies the guest kernel 6.12.62's requirements.

## Date

Investigation conducted: 2026-04-02
