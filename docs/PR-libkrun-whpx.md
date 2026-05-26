# PR: libkrun — Windows WHPX Hypervisor Backend

**Title:** `feat(windows): add native Windows WHPX hypervisor backend`

**Repo:** boxlite-ai/libkrun
**Branch:** feat/windows-whpx-support → main
**Stats:** 51 files changed, +27,501 / -261 (30 commits)

---

## Summary

Adds a complete Windows Hyper-V Platform (WHPX) hypervisor backend to libkrun, enabling native VM execution on Windows without WSL2. The implementation provides feature parity with the existing KVM (Linux) and Hypervisor.framework (macOS) backends.

**Key capabilities:**
- Full x86-64 guest boot via WHPX API (`windows-sys` 0.61)
- Userspace device emulation: PIC, PIT, IOAPIC, LAPIC, serial, CMOS RTC
- virtio-mmio devices: blk (async worker), net, vsock, p9, rng, balloon
- Multi-vCPU support (up to 4 vCPUs) with INIT-SIPI-SIPI AP bootstrap
- Lock-free interrupt injection via `SharedApicState` + atomic pull_irr
- ACPI tables (RSDP, RSDT, XSDT, MADT, DSDT with S5 shutdown)
- Linux kernel boot with custom initrd and cmdline

## Architecture

```
┌─────────────────────────────────────────────┐
│              libkrun API (FFI)              │
├─────────────────────────────────────────────┤
│  src/libkrun/src/windows_api.rs             │  ← krun_* FFI entry points
├─────────────────────────────────────────────┤
│  src/vmm/src/windows/                       │
│  ├── context.rs      VM configuration      │
│  ├── runner.rs       Main VMM event loop    │
│  ├── vcpu.rs         Per-vCPU state         │
│  ├── whpx.rs         WHPX API wrapper       │
│  ├── memory.rs       Guest physical memory  │
│  ├── insn.rs         x86 instruction decode │
│  ├── boot/           Kernel loading + ACPI  │
│  ├── devices/        Userspace device models│
│  │   ├── irq_chip    PIC → APIC transition │
│  │   ├── ioapic      I/O APIC emulation    │
│  │   ├── lapic       Local APIC + timer    │
│  │   ├── virtio/     Block, Net, Vsock...  │
│  │   └── ...         PIT, Serial, RTC      │
│  └── cmdline.rs      Kernel cmdline builder │
└─────────────────────────────────────────────┘
```

## Key Design Decisions

1. **Userspace APIC emulation** — WHPX's in-kernel APIC emulation crashes on some hardware (Win10 MBP 2014). We implement full LAPIC/IOAPIC in userspace with atomic lock-free interrupt delivery.

2. **Lock-free `SharedApicState`** — Device threads raise interrupts via `AtomicU64` IRR bitmask. vCPU threads pull pending interrupts without acquiring locks, avoiding contention in the hot path.

3. **ICR broadcast shorthand** — Linux kernel uses "All Excluding Self" (shorthand 0b11) for IPI broadcast. Without handling this, only 2 vCPUs work (coincidence: single AP gets the targeted IPI). Fixed by parsing ICR bits 19:18 and dispatching to all APs.

4. **Async virtio-blk worker** — Disk I/O runs on a dedicated thread with Windows overlapped I/O, preventing vCPU stalls during block operations.

5. **AF_UNIX sockets** (not TCP) — Host-guest vsock traffic uses Unix domain sockets for security and performance, matching the macOS/Linux backends.

6. **HLT tiered sleep** — Idle vCPUs use adaptive sleep (short spin → WaitForSingleObject) to balance latency vs CPU usage. LAPIC timer throttling prevents excessive wakeups.

## Changes by Area

### New Files (38 files under `src/vmm/src/windows/`)
- Boot: `acpi.rs`, `loader.rs`, `mp_table.rs`, `params.rs`, `setup.rs`
- Core: `context.rs`, `runner.rs`, `vcpu.rs`, `whpx.rs`, `memory.rs`, `insn.rs`, `cmdline.rs`, `types.rs`, `error.rs`
- Devices: `manager.rs`, `irq_chip.rs`, `ioapic.rs`, `lapic.rs`, `pic.rs`, `pit.rs`, `serial.rs`
- Virtio: `mmio.rs`, `queue.rs`, `block.rs`, `block_worker.rs`, `disk.rs`, `net.rs`, `vsock/mod.rs`, `vsock/connection.rs`, `vsock/packet.rs`, `p9/mod.rs`, `p9/filesystem.rs`, `p9/protocol.rs`, `rng.rs`, `balloon.rs`

### Modified Files
- `src/libkrun/src/lib.rs` — cfg-gate Unix-only APIs, expose `krun_start`/`krun_stop`/`krun_wait` for Windows
- `src/libkrun/src/windows_api.rs` — New FFI bridge for Windows-specific lifecycle
- `src/vmm/Cargo.toml` — Add Windows dependencies (windows-sys, crossbeam, parking_lot)
- `Cargo.lock` — Updated dependency tree

## Testing

- **Win11** (ThinkPad T14, i5-1135G7): vm-bench 8/8 PASS, net-test 8/8 PASS (4 vCPUs)
- **Win10** (MBP 2014, i7-4770HQ): vm-bench 8/8 PASS, net-test 8/8 PASS (4 vCPUs)
- **macOS/Linux**: Zero regression (code is fully cfg-gated behind `#[cfg(target_os = "windows")]`)

## Test Plan

- [ ] CI passes on Linux (existing tests unaffected)
- [ ] Manual verification on Windows with `boot_kernel` example
- [ ] vm-bench: create/exec/stop lifecycle (1 vCPU)
- [ ] net-test: network connectivity via vsock (4 vCPUs)
