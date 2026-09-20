# BoxLite VMM Design

BoxLite is replacing libkrun and libkrunfw with a virtualization stack it owns:

- a Rust VMM in two crates, `boxlite-hypervisor` and `boxlite-vmm`, linked into
  `boxlite-shim`;
- a pinned Linux LTS guest kernel, shipped as a file;
- `boxlite-guest` as the guest's PID 1.

This document is the design the VMM milestones build on
([#1512](https://github.com/boxlite-ai/boxlite/issues/1512)). It covers the
hypervisor backend interface, the device model, the VM lifecycle and its
errors, and the guest boot contract. libkrun ships unchanged until the new VMM
becomes the default in M5.

Diagrams of this design:

- [macOS Hypervisor.framework](./hvf.md)
- [Linux KVM](./kvm.md)
- [Windows Hypervisor Platform](./whp.md)
- [Guest memory](./memory.md)

BoxLite line references are to commit `42ec1a2a6`. External citations name
their project; their revisions are pinned under [References](#references).
`libkrun/` is the vendored copy at `src/deps/libkrun-sys/vendor/libkrun/`
(upstream `e12b9b3`).

## Scope

- **In scope:**
  - one VM per shim process, on macOS arm64 (Hypervisor.framework, "HVF") and
    on Linux x86_64 and arm64 (KVM);
  - boxes that work as they do on libkrun (M0–M5); the
    [guest boot contract](#guest-boot-contract) lists what changes underneath;
  - room for hot-plug mounts, dynamic resources, memory snapshots, GPUs (M6–M9)
    and Windows x86_64 hosts on WHP, the Windows Hypervisor Platform (M10).
- **Out of scope:** more than one VM per process, confidential computing, live
  migration, Intel Macs, and changes to libkrun.

## Decisions

| Decision | Choice | Why | Rejected |
| --- | --- | --- | --- |
| Minimum macOS | 15, using HVF's in-kernel GICv3 | `hv_gic_create` and `hv_gic_set_spi` exist from macOS 15.0 (`hv_gic.h`), so no HVF or KVM host needs an emulated interrupt controller, and libkrun already prefers the in-kernel GIC wherever the host has it | macOS 12 with a userspace GICv3, which libkrun falls back to below macOS 15 (`libkrun/src/vmm/src/builder.rs:892-894`), at about 3–4 engineer-weeks in M1 |
| SHARED share | virtio-fs in two stages: a FUSE server core for the SHARED share in M2, full passthrough for user volumes in M3 | Every box mounts the SHARED share, and guest file copy stages through it, so the first box already needs virtio-fs | Moving container layout and file copy off the SHARED share first, which changes the guest agent before the first box boots |
| Threads | One thread per vCPU, worker threads per device, and a poller on the thread that calls `run()` | HVF binds a vCPU to the thread that created it, and per-device workers keep a slow device, such as a blocking virtio-fs request, from stalling the others | One event loop for all devices (Firecracker), where one slow device stalls the rest; an async runtime inside the jailed shim, which complicates per-thread seccomp |
| Guest firmware | None: the VMM writes the kernel and its boot data into guest RAM and starts the boot vCPU at the kernel's entry point, as libkrun, Firecracker and crosvm do | The kernel ships with BoxLite as a file, so firmware and a boot loader would only add a step before it and a second guest program to ship, pin and trust | Firmware boot with edk2 UEFI or Rust Hypervisor Firmware, which cloud-hypervisor offers for disk images that carry their own boot loader (`README.md:114-118`, `:134-137`) and which only user-supplied OS images or Secure Boot would need |

macOS 12–14 keep running boxes on libkrun until M5. When M5 removes libkrun,
the support matrix in the root `README.md:241` changes from "macOS 12+" to macOS 15.

## Architecture

```text
boxlite-shim                    one jailed process per box
└─ engine adapter (M2)          implements Vmm and VmmInstanceImpl (src/boxlite/src/vmm/engine.rs:51-104)
   └─ boxlite_vmm::Vm           new(config), then run() → VmExit or Error
      ├─ vcpuN threads          Vcpu::run → VcpuExit → bus dispatch → run again
      ├─ device workers         virtqueues and host backends: disk, fs, vsock, net, console
      ├─ the run() thread       one poller: stop requests, vCPU outcomes, device failures
      └─ boxlite_hypervisor     Vm and Vcpu traits; hvf (macOS arm64), kvm (Linux) or whp (Windows, M10)
guest
└─ pinned LTS kernel → boxlite-guest as PID 1
```

The two crates split the work as follows:

- **`boxlite-hypervisor`** owns what differs between hosts: VM and vCPU handles,
  memory registration, interrupt injection, and decoding exits.
- **`boxlite-vmm`** owns the guest machine: configuration, memory layout,
  devices, threads, and lifecycle.

KVM memory slots stay in the KVM backend, ARM exception syndromes in the HVF
backend and x86 instruction decoding in the WHP one; `boxlite-vmm` sees none.

## Hypervisor backend interface

The backend is chosen at compile time, because no host has more than one of HVF,
KVM and WHP. M1 adds `HvfVm` and `KvmVm`, M10 adds `WhpVm`, and each implements
the traits in `src/hypervisor/src/`. `boxlite-vmm` is written against those
traits, so its tests can drive a fake backend, and M4's fault-injection tests
need no hypervisor.

| Operation | Contract | HVF | KVM | WHP (M10) |
| --- | --- | --- | --- | --- |
| Create the VM | the backend's constructor | `hv_vm_create`, one VM per process (`hv_vm.h`) | `KVM_CREATE_VM` on `/dev/kvm`, then the `KVM_SET_TSS_ADDR` the KVM API requires on Intel hosts | `WHvCreatePartition`; `WHvSetPartitionProperty` for the vCPU count; then `WHvSetupPartition` |
| Create the interrupt controller | the backend's constructor | `hv_gic_create`, after the VM and before any vCPU (`hv_gic.h`) | x86_64: `KVM_CREATE_IRQCHIP` and `KVM_CREATE_PIT2`, before any vCPU; arm64: a `KVM_DEV_TYPE_ARM_VGIC_V3` device with its distributor and redistributor addresses, initialised with `KVM_DEV_ARM_VGIC_CTRL_INIT` once every vCPU exists | local APIC emulation, set with `WHvSetPartitionProperty` before `WHvSetupPartition` |
| Map guest memory | `Vm::map_memory` (`unsafe`) | `hv_vm_map` | `KVM_SET_USER_MEMORY_REGION`; the backend picks the slot | `WHvMapGpaRange` |
| Unmap guest memory | `Vm::unmap_memory` | `hv_vm_unmap` | the same slot, set to size 0 | `WHvUnmapGpaRange` |
| Create a vCPU | `Vm::create_vcpu`, on the thread that will run it | `hv_vcpu_create`, which also returns the `hv_vcpu_exit_t` the vCPU reports its exits in | `KVM_CREATE_VCPU`, then `mmap` of its `kvm_run`; `KVM_ARM_VCPU_INIT` on arm64, with secondaries powered off (`KVM_ARM_VCPU_POWER_OFF`) | `WHvCreateVirtualProcessor` |
| Set boot registers | M1 adds it | `hv_vcpu_set_reg`, `hv_vcpu_set_sys_reg` | `KVM_SET_ONE_REG` on arm64; on x86_64 `KVM_SET_CPUID2`, then `KVM_SET_MSRS`, `KVM_SET_REGS`, `KVM_SET_FPU`, `KVM_SET_SREGS` and the local APIC's LINT pins, in Firecracker's order ([Firecracker `src/vmm/src/arch/x86_64/vcpu.rs:222–301`](https://github.com/firecracker-microvm/firecracker/blob/68698adfee9b252df130b7a98e3ba04eb81f0f54/src/vmm/src/arch/x86_64/vcpu.rs#L222-L301)) | `WHvSetVirtualProcessorRegisters` |
| Run to the next exit | `Vcpu::run` → `VcpuExit` | `hv_vcpu_run` | `KVM_RUN` | `WHvRunVirtualProcessor` |
| Complete pending I/O before stop or state capture | `Vcpu::complete_pending_io`; no further guest instruction executes | write the read result and advance PC without `hv_vcpu_run` | `KVM_RUN` with `immediate_exit` set; KVM completes the access before checking it | finish emulation and update registers/RIP without `WHvRunVirtualProcessor` |
| Read the exit | the backend decodes it into a `VcpuExit` | `hv_vcpu_exit_t`: the reason and, for an exception, the syndrome and guest address | `kvm_run.exit_reason` and its union | the `WHV_RUN_VP_EXIT_CONTEXT` that `WHvRunVirtualProcessor` fills |
| Kick from another thread | `VcpuHandle::kick` | `hv_vcpus_exit` | set `immediate_exit`, then signal the vCPU thread | `WHvCancelRunVirtualProcessor` |
| Set an interrupt line | `Vm::set_irq_line` | `hv_gic_set_spi` | `KVM_IRQ_LINE` | a userspace IOAPIC, in a crate M10 picks, then `WHvRequestInterrupt` |

HVF and KVM keep these rules; [M10](#room-for-later-milestones) covers WHP:

- **Creation.**
  - The backend's constructor creates the VM and the host's in-kernel
    interrupt controller and timer: a GICv3 on arm64; the PIC, IOAPIC, local
    APICs and PIT on x86_64, as libkrun creates them
    (`libkrun/src/devices/src/legacy/kvmioapic.rs:19-25`).
  - HVF needs its GIC before any vCPU exists (`hv_gic.h`), and so does KVM's
    x86 irqchip.
  - KVM on arm64 initialises its GIC only after every vCPU exists, so that
    backend initialises it once, in the first `run` on any vCPU, before any
    vCPU enters the guest.
  - As a result, the VMM creates every vCPU before it runs any.
- **Thread binding.** HVF accepts vCPU calls only from the thread that created
  the vCPU (`hv_vcpu.h`); KVM only recommends it
  ([KVM API](https://docs.kernel.org/virt/kvm/api.html#general-description)).
  Backend vCPU types are `!Send`, so the compiler enforces the HVF rule on both
  hosts.
- **Kicks.**
  - A `VcpuHandle` is `Clone + Send + Sync`. After a kick, `run` returns
    `VcpuExit::Interrupted`.
  - A kick that lands while the vCPU is outside the guest makes its next `run`
    return at once.
  - Kicking a dropped vCPU does nothing, so a stop can kick every vCPU without
    tracking which ones already ended.
- **Memory lifetime.**
  - `map_memory` is `unsafe`. The caller keeps the host range mapped, backing
    nothing but that guest region, until both the guest mapping is gone
    (successful `unmap_memory`, or the VM and all its vCPUs dropped) and every
    host-side user has stopped accessing the range. This includes device
    workers and in-flight host I/O. A failed unmap can leave the guest mapping
    in place, and on KVM a live vCPU keeps the VM's mappings alive. Shutdown
    stops and joins the vCPU and device threads and drains or cancels host
    I/O before releasing the allocation.
  - The guest can change that memory at any time. VMM code uses guest-memory
    access primitives that preserve Rust's aliasing rules, not ordinary Rust
    references into guest-accessible memory. Conflicting host-side accesses
    require synchronization or atomic operations. Guest-shared protocols,
    such as virtqueues, require their specified atomicity and memory ordering;
    a host mutex does not synchronize with the guest. Raw pointers and
    [volatile accesses](https://doc.rust-lang.org/std/ptr/fn.read_volatile.html)
    alone do not provide these guarantees.
  - Both ranges align to the host page size, which is 16 KiB on Apple silicon.
- **Interrupt lines.** A line is a GIC SPI INTID (32 and up) on arm64 and a GSI
  on x86_64. Devices set lines from their own threads. An edge-triggered
  interrupt is a set followed by a clear.
- **Errors.**
  - `boxlite_hypervisor::Error` names the failed operation and its resource
    (vCPU id, guest address, or line), and keeps the host cause as an
    `io::Error`: `errno` on KVM, the `hv_return_t` on HVF.
  - A host that cannot run VMs reports `io::ErrorKind::Unsupported`. Missing
    access to the hypervisor reports `io::ErrorKind::PermissionDenied`.
  - An exit the backend does not handle becomes `Error::UnhandledExit`, never
    a panic. It carries the backend's description of the exit for
    diagnostics, so raw exit reasons stay inside the backend, as with
    Firecracker's
    [`UnhandledKvmExit(String)`](https://github.com/firecracker-microvm/firecracker/blob/68698adfee9b252df130b7a98e3ba04eb81f0f54/src/vmm/src/vstate/vcpu.rs#L48)
    and hyperlight's
    [`Unknown(String)`](https://github.com/hyperlight-dev/hyperlight/blob/398e7957c194ef6227d79fa729fd8dd43e5dc117/src/hyperlight_host/src/hypervisor/virtual_machine/mod.rs#L155).

The traits do not yet cover vCPU registers. M1 adds the register access that
boot needs: PC, X0, PSTATE and MPIDR_EL1 on arm64, where MPIDR_EL1 matches each
vCPU to its GIC redistributor; registers, segments, CPUID and MSRs on x86_64.
M8 extends it to saving and restoring full vCPU state.

The names come from a survey of nine projects: crosvm, cloud-hypervisor,
Firecracker, libkrun, hyperlight, alioth, applevisor, kvm-ioctls and QEMU
(links under [References](#references)).

- **`Vm`, `Vcpu`, `run` and `VcpuExit`** each appear in most of them: `Vm` and
  `Vcpu` in seven, `run` in six, `VcpuExit` in five.
- **Kicks, memory mapping, interrupts and errors** have no dominant name, so the
  design takes the most common one for each:
  - the verb "kick", on a `VcpuHandle`;
  - `map_memory`, as the HVF-capable projects name it;
  - `set_irq_line(line, level)`;
  - one `Error` with a variant per operation.

### Exit contract

The guest reads and writes RAM mapped with `map_memory` without an exit to the
VMM. An access to an address no mapping covers, such as a device window, is an
MMIO exit.

A process in the guest runs on a vCPU at EL0 (ring 3 on x86_64), and the guest
kernel at EL1 (ring 0). The process's system calls and context switches stay
inside the guest; only the exits below reach the VMM.

`VcpuExit` (`src/hypervisor/src/exit.rs`) is what `run` returns. MMIO and port
data borrow a per-vCPU buffer inside the backend, as in libkrun and kvm-ioctls.
The VMM therefore handles an exit before it runs that vCPU again, and the next
`run` completes the guest's instruction. Before stopping or saving state, the
VMM releases the borrowed exit and calls `complete_pending_io` instead. That
operation succeeds without guest execution when nothing is pending, and a
successfully completed access is not completed again.

| Exit | Meaning | HVF | KVM | WHP (M10) |
| --- | --- | --- | --- | --- |
| `MmioRead`, `MmioWrite` | Access to an emulated device | HVF data abort: `HV_EXIT_REASON_EXCEPTION` with a data-abort syndrome | `KVM_EXIT_MMIO` | `WHvRunVpExitReasonMemoryAccess` |
| `IoIn`, `IoOut` (x86_64 only) | One port access to the 8250 serial, CMOS RTC or i8042; string port I/O is `Error::UnhandledExit` | none | `KVM_EXIT_IO` | `WHvRunVpExitReasonX64IoPortAccess`, which also carries the ports of the userspace PIC and PIT (M10) |
| `Interrupted` | A kick | `HV_EXIT_REASON_CANCELED`, after `hv_vcpus_exit` | `KVM_RUN` returning `EINTR` | `WHvRunVpExitReasonCanceled` |
| `Halted` | The vCPU waits for an interrupt | HVF traps `WFI` | KVM with the in-kernel irqchip waits in the kernel, and the backend still maps `KVM_EXIT_HLT`, which only a VM without one returns (as the probe VM in `src/boxlite/src/system_check.rs` does) | with local APIC emulation, `HLT` waits inside `WHvRunVirtualProcessor`; QEMU handles `WHvRunVpExitReasonX64Halt` only without it (`target/i386/whpx/whpx-all.c:2337-2342`) |
| `Shutdown` | The guest powered off | PSCI `SYSTEM_OFF`, decoded by the HVF backend | `KVM_EXIT_SYSTEM_EVENT` | the i8042 reset below |
| `Reset` | The guest reset | PSCI `SYSTEM_RESET`, decoded by the HVF backend | a `KVM_EXIT_SYSTEM_EVENT` reset on arm64; an x86 triple fault (`KVM_EXIT_SHUTDOWN`) | the i8042 reset below |

On x86_64 the guest resets through the i8042 port. That reset arrives as an
`IoOut`, and the VMM's i8042 device turns it into the end of the VM.

KVM handles PSCI `CPU_ON` for secondary vCPUs in the kernel. M1 extends the
current M0 `VcpuExit` enum with an HVF CPU-start request alongside the boot
register API; neither is implemented by the current HVF stub. That request
must carry the target MPIDR affinity, entry address and context ID, and let the
VMM supply the guest-visible PSCI result. The VMM validates the target and its
startup state, sends the entry/context to the target's owning thread, and
returns success or the PSCI failure before the caller resumes. On arm64 only
the boot vCPU starts at the kernel's entry point; each secondary
starts powered off until `CPU_ON` gives it one. An HVF secondary waits parked,
so the stop path's unpark also wakes one the guest never started.

How each host completes an access on the next `run`:

- **HVF.** The backend decodes a data abort itself: the syndrome gives the
  access size (SAS), direction (WnR) and register (SRT), and
  `physical_address` the guest address. On the next `run` it writes the
  register for a read and advances PC by 4, as libkrun does
  (`libkrun/src/hvf/src/lib.rs:554-576`, `:615-650`).
- **KVM.** The kernel completes the access on the next `KVM_RUN`, from the
  data the VMM leaves in `kvm_run`.
- **WHP.** A memory-access exit carries the instruction bytes, so
  `whp::emulator` decodes the access. A port-access exit carries the port,
  size and `RAX`. On the next `run` the backend writes the destination
  register for a read and advances RIP.

Hypervisor.framework can also exit with `HV_EXIT_REASON_VTIMER_ACTIVATED`
(`hv_vcpu_types.h`), but not with the in-kernel GIC, which handles the guest's
virtual timer itself: QEMU asserts that this exit never arrives with it
(`target/arm/hvf/hvf.c:2580-2581`) and notes that HVF then handles vtimer
wake-ups (`:2670-2671`).

Every Linux boot also raises exceptions that the HVF backend resolves itself,
without a `VcpuExit`, before it enters the guest again:

- **PSCI queries.** Linux first calls `PSCI_VERSION` and `MIGRATE_INFO_TYPE`
  (`drivers/firmware/psci/psci.c:638`, `:651`). The backend answers both in
  X0, as libkrun does (`libkrun/src/hvf/src/lib.rs:526-535`), and returns
  `NOT_SUPPORTED` for any other call it does not act on, as KVM does
  (`arch/arm64/kvm/psci.c:306-307`).
- **System registers.** Linux reads ID registers that HVF does not model, such
  as `ID_AA64PFR2_EL1` (`arch/arm64/kernel/cpuinfo.c:457-472`; QEMU
  `target/arm/hvf/hvf.c:1145`). A trapped ID register reads as zero, as in QEMU
  (`hvf.c:1873-1877`) and libkrun
  (`libkrun/src/devices/src/legacy/vcpu.rs:145-150`). The backend also
  emulates the OS lock as QEMU does: a write to `OSLAR_EL1` sets the lock that
  `OSLSR_EL1` reports, and `OSDLR_EL1` is a dummy register
  (`hvf.c:1746-1750`, `:2044-2046`, `:2056-2058`). libkrun ignores writes to
  both (`vcpu.rs:258-260`).
- **WFE.** HVF traps it like `WFI`, but the backend only advances PC, as QEMU
  does (`hvf.c:2493-2497`).

## Device model

### Guest memory layout

Two translations stand between a guest access and host memory. The guest
kernel's page tables map a guest virtual address to a guest physical one, and
the host hypervisor's stage-2 translation, EPT or NPT on x86_64, maps that to
the shim's memory from the regions `map_memory` registers. An address no region
covers is an MMIO exit, except the windows the host's in-kernel interrupt
controller claims.

On arm64 the layout follows Firecracker's, with a PL011 in its serial slot, and
keeps RAM at `0x8000_0000` as libkrun does today.

| Address | Use | Precedent |
| --- | --- | --- |
| below `0x3FFF_0000` | GICv3 redistributors, 128 KiB per vCPU | Firecracker, crosvm, dragonball |
| `0x3FFF_0000` | GICv3 distributor, 64 KiB | Firecracker, crosvm, dragonball |
| `0x4000_1000` | PL031 RTC, SPI INTID 33 | Firecracker |
| `0x4000_2000` | PL011 UART, SPI INTID 32 | Firecracker's serial slot |
| `0x4000_3000`–`0x7000_0000` | virtio-mmio devices, 4 KiB each, with SPIs from INTID 34 | Firecracker's device window; libkrun assigns SPIs in sequence from INTID 32 |
| `0x7000_0000`–`0x8000_0000` | PCI ECAM, reserved for M9 | Firecracker |
| `0x8000_0000` | RAM: the kernel `Image` at its text offset, and the device tree in the last 2 MiB | libkrun, Firecracker, crosvm, dragonball |
| above RAM | hotplug memory, reserved for M7 | cloud-hypervisor (virtio-mem); libkrun puts shared memory there |
| above the hotplug region | 64-bit PCI BAR window, reserved for M9 | Firecracker and alioth reserve a 64-bit MMIO window |

On x86_64 the layout uses the values most surveyed VMMs share.

| Address or port | Use | Precedent |
| --- | --- | --- |
| `0x7000` | `boot_params` (the zero page) | five of six |
| `0x2_0000` | kernel command line | five of six |
| `0x9_FC00` | MP table, in the last KiB below 640 KiB | Firecracker, libkrun |
| `0x10_0000` | `bzImage` load address; an ELF `vmlinux` loads where its headers say | four of six |
| below `0xC000_0000`, and above 4 GiB | RAM, split around the 32-bit MMIO hole | Firecracker, cloud-hypervisor, dragonball |
| `0xC000_0000`–`0xD000_0000` | 32-bit PCI BAR window, reserved for M9 | Firecracker, cloud-hypervisor and alioth give PCI BARs space in the hole |
| `0xD000_0000`–`0xE000_0000` | virtio-mmio devices, 4 KiB each, with interrupts from GSI 5 | device window: libkrun, crosvm; GSI 5: Firecracker, libkrun, dragonball |
| `0xE000_0000`–`0xF000_0000` | PCI ECAM, reserved for M9 | alioth |
| `0xFEC0_0000`, `0xFEE0_0000` | IOAPIC and local APIC, both in the kernel on KVM; WHP (M10) emulates only the local APIC | architectural |
| above RAM | hotplug memory (M7), then a 64-bit PCI BAR window (M9) | as on arm64 |
| ports `0x3F8`, `0x70`–`0x71`, `0x60` and `0x64` | 8250 UART on GSI 4, CMOS RTC, i8042 | PC standard |

x86_64 guests boot without ACPI or a device tree, so the command line announces
each virtio-mmio device (`virtio_mmio.device=4K@0xd0000000:5`), as libkrun does
today.

### Buses

- **Which buses.** Every host has an MMIO bus; x86_64 adds a port I/O bus.
- **Device API.** Devices implement `BusDevice` and see offsets from their base:
  `read(&mut self, offset: u64, data: &mut [u8])` and
  `write(&mut self, offset: u64, data: &[u8])`. These are the most common
  shapes among seven surveyed VMMs: `Bus` in six, `BusDevice` in four, and
  offset-based access in all seven.
- **Registration.** `insert` rejects overlapping ranges with `Overlap`.
  Devices register while the VM is built; M6 and M7 change the guest without
  adding bus devices.
- **Locking.** A vCPU thread holds a device's lock for one register access and
  hands anything that can block to the device's worker.

### Interrupts

- **No emulated controller.** HVF and KVM provide in-kernel interrupt
  controllers, so the VMM emulates none. WHP (M10) emulates only local APICs.
- **Line assignment.** The VMM gives each device a line when it builds the
  machine. It declares virtio-mmio interrupts edge-triggered, as Firecracker,
  libkrun and dragonball do.
- **Raising an interrupt.** Devices raise their lines from their own threads
  through the VMM's interrupt path, which calls `Vm::set_irq_line` and then
  unparks halted vCPUs.
- **Naming.** M1 names the type devices hold. The survey found no dominant
  name: `VirtioInterrupt`, `InterruptSourceGroup` and `IrqSender` each appear
  once or twice.

### Devices by milestone

- **M1:**
  - arm64: PL011, PL031 and PSCI;
  - x86_64: 8250 serial, CMOS RTC, and the i8042 reset.
- **M2:**
  - the virtio-mmio transport, with one split-virtqueue implementation;
  - virtio-blk, virtio-vsock, virtio-net, virtio-console and virtio-rng;
  - virtio-balloon with free page reporting, so the host can reclaim unused
    guest memory as it can with libkrun today: at once on Linux, and under
    memory pressure on macOS, where `MADV_DONTNEED` only deactivates pages;
  - the virtio-fs core.
- **M3:** virtio-fs passthrough for user volumes.
- **M7:** virtio-mem.
- **M9:** a PCI transport for passed-through devices, VFIO, and virtio-gpu.

### Threads

- **vCPU threads.**
  - `run()` spawns one per vCPU, named `vcpuN`. Each creates its vCPU and waits
    until every vCPU exists.
  - It then loops: run, dispatch the exit to a bus, run again.
  - On `Halted`, which in practice only HVF returns, it parks until the guest timer's
    deadline, an interrupt, or a stop.
  - The VMM's interrupt path unparks halted vCPUs after it sets a line;
    `Vm::set_irq_line` itself wakes no thread. M1 decides how an IPI from
    another vCPU wakes a parked one.
  - With the in-kernel GIC, `WFI` still traps (`target/arm/hvf/hvf.c:2493-2497`),
    but QEMU then arms no timer of its own and leaves vtimer wake-ups to HVF
    (`:1496-1499`, `:2670-2671`). libkrun instead parks until the deadline in
    `CNTV_CVAL_EL0` (`libkrun/src/hvf/src/lib.rs:705-721`). M1 confirms which
    of the two wakes a parked vCPU on time.
- **Device workers.**
  - Each virtio device owns its worker threads.
  - A vCPU's queue-notify write wakes the worker through an event.
  - The worker processes the queue and raises the device's interrupt itself.
- **The `run()` thread.**
  - It waits on one poller for stop requests, vCPU outcomes and device
    failures.
  - The poller is `mio`, which uses epoll on Linux and kqueue on macOS and is
    already in `Cargo.lock` through tokio. rust-vmm's event-manager and crosvm's
    `WaitContext` are epoll-only.
- **Stopping.** The first terminal event decides the outcome. The `run()` thread
  then:
  1. sets the stop flag;
  2. kicks and unparks every vCPU;
  3. joins the vCPU threads;
  4. stops and joins the device workers;
  5. returns.

## VM lifecycle and errors

M1 implements this API in `boxlite-vmm`, and the M2 engine adapter calls it from
`VmmInstance::enter`:

```rust
let mut vm = Vm::new(config)?; // validate, create the host VM, map RAM, load the kernel, build devices
let stop = vm.stop_handle();   // Clone + Send; the shim's SIGTERM path calls stop.stop()
let exit = vm.run()?;          // VmExit::GuestShutdown, GuestReset or StopRequested
```

The current M0 skeleton keeps `Vm`, `VmExit`, `Error` and `Result`
crate-visible. M1 exposes them together when the lifecycle is implemented;
the M2 adapter's error mapping below describes that future public API.

- **`run` reports how the VM ended, not the box's exit code.**
  - The guest agent writes the box's exit code to `exit.json` on the SHARED
    share, and it keeps travelling that way (`src/guest/src/service/container.rs:406-488`).
  - libkrun never carried it. It ends the shim with `_exit`
    (`libkrun/src/vmm/src/lib.rs:359-372`), and BoxLite never sets a code, so
    the shim exits 0.
- **The VMM never restarts a guest.**
  - A reset ends the VM just as a power-off does, as with libkrun.
  - The guest agent ends every box with `reboot(RESTART)`, because x86_64 has
    no ACPI power-off (`src/guest/src/service/container.rs:472-485`).
- **Nothing in the VMM exits the process,** and no guest-controlled input can
  panic it.
- **Configuration is validated in `Vm::new`.**
  - The checks are vCPU count, memory size and command-line length, against
    the layout's limits.
  - The fields are `vcpu_count` (four of six surveyed VMMs) and `memory_mib`.
    `memory_mib` is BoxLite's own `InstanceSpec` name; no VMM name dominates.
  - The errors for vCPU count and memory size are `InvalidVcpuCount` and
    `InvalidMemorySize`, as in Firecracker, libkrun and dragonball. M1 names
    the command-line error with the rest of the boot configuration.
- **Errors keep their cause.**
  - `boxlite_vmm::Error` wraps `boxlite_hypervisor::Error` and adds
    configuration, device and guest failures, keeping the chain through
    `source()`.
  - The adapter maps an `Unsupported` or `PermissionDenied` host cause to
    `BoxliteError::Unsupported` and everything else to `BoxliteError::Engine`.
  - It keeps the shim's exit-file format (`src/boxlite/src/vmm/exit_info.rs:80`).

### Where the engine plugs in (M2)

- **Hard-coded engine.**
  - `src/boxlite/src/litebox/init/tasks/vmm_spawn.rs:238` and `:413` hard-code
    `VmmKind::Libkrun`.
  - `ShimController` overwrites `InstanceSpec.engine` with its own engine
    (`src/boxlite/src/vmm/controller/shim.rs:322`).
  - The per-box `BoxConfig.engine_kind` (`src/boxlite/src/litebox/config.rs:44`)
    is never read when a box spawns.
- **libkrun assumptions outside `krun/`.**
  - The jailer copies libkrunfw into every box
    (`src/boxlite/src/jailer/shim_copy.rs:103-105`).
  - The network socket name derives from libkrun's `-krun.sock` suffix
    (`src/boxlite/src/net/socket_path.rs:51-59`).
  - The Linux seccomp filter is written for libkrun's threads
    (`src/boxlite/src/jailer/seccomp.rs:239-243`).

## Guest boot contract

The table compares what the guest gets from libkrun today with what it gets
from the new VMM.

| Item | libkrun today | New VMM | Milestone |
| --- | --- | --- | --- |
| Kernel | libkrunfw: Linux 6.12 with 32 patches, loaded as a shared library | a pinned LTS kernel file with BoxLite's config: `Image` on arm64; `bzImage` or ELF `vmlinux` on x86_64 | M1 |
| PID 1 | `init.krun`, which starts the agent as its child | `boxlite-guest` | M2 |
| Root filesystem | a throwaway virtio-fs root; `init.krun` then mounts `/dev/vdb` | the kernel mounts `/dev/vdb` (ext4) read-only, and the disk reports itself read-only | M2 |
| Command line | libkrun's defaults (`libkrun/src/vmm/src/vmm_config/kernel_cmdline.rs:7-11`), `init=/init.krun` and `KRUN_*` variables | `console=hvc0 root=/dev/vdb ro panic=-1 reboot=k init=/boxlite/bin/boxlite-guest`, then the agent's environment as `KEY=value`, then `-- --listen vsock://2695 --notify vsock://2696`; on x86_64, one `virtio_mmio.device=` per device | M2 |
| Disks | `vda` is the container disk (qcow2, read-write) and `vdb` the guest root (raw, read-only); names follow attach order | unchanged | M2 |
| virtio-fs | one device per share: `BoxLiteShared` (read-write) and one per volume | one device, with each share as an export under it | M2 (SHARED), M3 (volumes) |
| vsock | guest CID 3; host `box.sock` to guest port 2695 for gRPC, guest to host port 2696 as the ready signal (`src/shared/src/constants.rs:20-26`) | unchanged | M2 |
| Network | virtio-net to gvproxy in the shim (a stream socket with 4-byte length prefixes on Linux, datagrams with the `VFKT` handshake on macOS), with 192.168.127.2/24 set by the agent | unchanged; no TSI | M2 |
| Console | virtio-console `hvc0` into `console.log`, truncated at each boot | unchanged; M1 first boots on the PL011 or 8250 | M1–M2 |
| Other devices | virtio-rng, and virtio-balloon with free page reporting (`libkrun/src/devices/src/virtio/balloon/device.rs:28-30`) | unchanged | M2 |
| Wall clock | PL031 (arm64) or CMOS (x86_64) at boot; on macOS, resync over vsock datagram port 123 | the same at boot; M2 chooses the resync mechanism | M1–M2 |
| End of the VM | the agent writes `exit.json`, syncs and calls `reboot(RESTART)`; libkrun then exits the process | the same guest steps; `run()` returns `GuestReset` | M2 |
| Start failure | libkrun reports every error as `-EINVAL`, and the adapter probes the hypervisor for the cause | typed errors | M2 |

M1 boots only a test initramfs, so its command line names the serial console
(`console=ttyAMA0` for the arm64 PL011, `console=ttyS0` for the x86 8250) and no
root disk.

As PID 1, `boxlite-guest` takes on these duties in M2:

- **Take over `init.krun`'s setup** (`libkrun/init/init.c:504-570`, `:1290`,
  `:1364-1374`):
  - mount devtmpfs on `/dev`, proc, sysfs, cgroup2 on `/sys/fs/cgroup`, devpts,
    and `/dev/shm`;
  - make `/` a shared mount;
  - set `RLIMIT_NPROC` and `RLIMIT_NOFILE`;
  - set the hostname.
- **Bring `lo` up in every box.** Today the agent raises it only when
  networking is enabled (`src/guest/src/network.rs:178-192`), and boxes without
  networking still need 127.0.0.1.
- **Never exit.**
  - Today the panic hook calls `exit(1)` (`src/guest/src/main.rs:83-85`). As
    PID 1, that panics a stock kernel.
  - Fatal paths therefore sync and reset, and `panic=-1` turns a kernel panic
    into a reset.
- **Keep boot inputs small.**
  - The kernel caps the command line: 2 KiB on arm64
    (`src/boxlite/src/litebox/init/tasks/guest_entrypoint.rs:36-41`).
  - It also caps the number of boot environment entries: 32 under libkrunfw's
    `CONFIG_INIT_ENV_ARG_LIMIT`.
  - Everything else keeps arriving over gRPC.

These three boot/runtime integration patch groups come from BoxLite's pinned
[libkrunfw revision `e0647fa7`][libkrunfw-patches]. They are the patches this
boot contract replaces, rather than an inventory of every architecture or
device patch in libkrunfw:

- **Init death and reboot:** [0001, `Don't panic when init dies`][init-death]
  and [0002, `Ignore run_cmd on orderly reboot`][orderly-reboot]. An agent
  that never exits, plus `panic=-1`, replaces them.
- **vsock datagrams:** the [0003–0008 patch series][libkrunfw-patches], ending
  in `0008-virtio-vsock-support-dgrams.patch`. The macOS clock resync uses
  datagrams; M2 chooses its replacement.
- **TSI:** [0009, `Transparent Socket Impersonation implementation`][tsi]
  and [0010, `allow hijacking sockets`][tsi-hijack]. Unused: the network
  factory always returns gvproxy (`src/boxlite/src/net/mod.rs:481-484`).

[libkrunfw-patches]: https://github.com/boxlite-ai/libkrunfw/tree/e0647fa7a3932c4570fb2c0fd483b9f7a382ebdd/patches
[init-death]: https://github.com/boxlite-ai/libkrunfw/blob/e0647fa7a3932c4570fb2c0fd483b9f7a382ebdd/patches/0001-krunfw-Don-t-panic-when-init-dies.patch
[orderly-reboot]: https://github.com/boxlite-ai/libkrunfw/blob/e0647fa7a3932c4570fb2c0fd483b9f7a382ebdd/patches/0002-krunfw-Ignore-run_cmd-on-orderly-reboot.patch
[tsi]: https://github.com/boxlite-ai/libkrunfw/blob/e0647fa7a3932c4570fb2c0fd483b9f7a382ebdd/patches/0009-Transparent-Socket-Impersonation-implementation.patch
[tsi-hijack]: https://github.com/boxlite-ai/libkrunfw/blob/e0647fa7a3932c4570fb2c0fd483b9f7a382ebdd/patches/0010-tsi-allow-hijacking-sockets-tsi_hijack.patch

### Boot path

No firmware or boot loader runs in the guest. As in libkrun, Firecracker and
crosvm, the VMM is the boot loader: it writes the kernel and its boot data into
guest RAM and starts the boot vCPU at the kernel's entry point, as Linux's boot
protocols require (`Documentation/arch/arm64/booting.rst`,
`Documentation/arch/x86/boot.rst`).

| Step | arm64 (HVF, KVM) | x86_64 (KVM, WHP) |
| --- | --- | --- |
| Load the kernel | the `Image` at its text offset from a 2 MiB aligned base (`booting.rst:135-137`) | a `bzImage`'s protected-mode kernel at 1 MiB, or an ELF `vmlinux` at the addresses its program headers name, 16 MiB by default (`arch/x86/Kconfig:2096-2098`) |
| Describe the machine | a device tree in the last 2 MiB of RAM: memory, each CPU with the `psci` enable method, a `psci` node with the HVC conduit, the GIC, the timer, the `apb_pclk` clock the PL011 and PL031 name, the PL011, the PL031, each device as `virtio,mmio`, and the command line as `bootargs`; Firecracker writes the same nodes, with an `ns16550a` UART in place of the PL011 ([Firecracker `src/vmm/src/arch/aarch64/fdt.rs:351–397`](https://github.com/firecracker-microvm/firecracker/blob/68698adfee9b252df130b7a98e3ba04eb81f0f54/src/vmm/src/arch/aarch64/fdt.rs#L351-L397)) | `boot_params` at `0x7000`: the setup header, which a `bzImage` carries at offset `0x1f1` and the VMM fills in for a `vmlinux`, the e820 memory map, and `cmd_line_ptr` to the command line at `0x2_0000`, which names each `virtio_mmio.device=` (`boot.rst:1371-1376`); an MP table at `0x9_FC00` that lists each vCPU, the IOAPIC and its interrupt sources |
| CPU state at entry | MMU off, interrupts masked in `PSTATE.DAIF`, at EL1 (`booting.rst:169-176`) | 64-bit mode with paging on: identity-mapped page tables and a GDT with flat `__BOOT_CS` and `__BOOT_DS`, interrupts off (`boot.rst:1394-1402`) |
| Boot vCPU registers | PC at the `Image`'s first instruction, X0 at the device tree, X1 to X3 zero (`booting.rst:162-165`, `:423-424`) | RIP at the 64-bit entry, which for a `bzImage` is the load address plus `0x200`; RSI at `boot_params` (`boot.rst:1390-1392`, `:1401-1402`) |
| Other vCPUs | powered off until the kernel calls PSCI `CPU_ON` (`booting.rst:447-453`) | waiting for the boot vCPU's INIT and SIPI to each one the MP table lists; KVM's in-kernel local APIC holds them in `KVM_MP_STATE_UNINITIALIZED` (`KVM_GET_MP_STATE` in the KVM API) |

Firecracker sets the same state. On arm64 every vCPU gets PSTATE at EL1h with
DAIF masked, and only vCPU 0 gets PC and X0
([Firecracker `src/vmm/src/arch/aarch64/regs.rs:23`](https://github.com/firecracker-microvm/firecracker/blob/68698adfee9b252df130b7a98e3ba04eb81f0f54/src/vmm/src/arch/aarch64/regs.rs#L23),
[Firecracker `src/vmm/src/arch/aarch64/vcpu.rs:338–373`](https://github.com/firecracker-microvm/firecracker/blob/68698adfee9b252df130b7a98e3ba04eb81f0f54/src/vmm/src/arch/aarch64/vcpu.rs#L338-L373)).
On x86_64 the boot vCPU gets RIP, RSI pointing at the zero page, long mode, and
identity page tables from `0x9000` ([Firecracker `src/vmm/src/arch/x86_64/regs.rs:86–107`](https://github.com/firecracker-microvm/firecracker/blob/68698adfee9b252df130b7a98e3ba04eb81f0f54/src/vmm/src/arch/x86_64/regs.rs#L86-L107),
[Firecracker `src/vmm/src/arch/x86_64/regs.rs:247–282`](https://github.com/firecracker-microvm/firecracker/blob/68698adfee9b252df130b7a98e3ba04eb81f0f54/src/vmm/src/arch/x86_64/regs.rs#L247-L282)).

x86_64 needs the MP table because it boots without ACPI or a device tree:
without the table or an ACPI MADT, Linux turns off the IOAPIC and SMP
(`arch/x86/kernel/apic/apic.c:1270-1276`, `arch/x86/kernel/smpboot.c:1088-1090`).
Linux looks for it in low memory, including the last KiB below 640 KiB
(`arch/x86/kernel/mpparse.c:612-614`), where Firecracker and libkrun write it
([Firecracker `src/vmm/src/arch/x86_64/mod.rs:271–272`](https://github.com/firecracker-microvm/firecracker/blob/68698adfee9b252df130b7a98e3ba04eb81f0f54/src/vmm/src/arch/x86_64/mod.rs#L271-L272),
`libkrun/src/arch/src/x86_64/mod.rs:266-268`). Firecracker's table lists each
vCPU, an ISA bus, the IOAPIC and its interrupt sources
([Firecracker `src/vmm/src/arch/x86_64/mptable.rs:177–231`](https://github.com/firecracker-microvm/firecracker/blob/68698adfee9b252df130b7a98e3ba04eb81f0f54/src/vmm/src/arch/x86_64/mptable.rs#L177-L231)).

The kernel then boots itself (Linux v6.12):

1. **Entry.** On arm64 the `Image` header's first two instructions run:
   `efi_signature_nop`, a NOP that carries the PE/COFF `MZ` magic, then
   `b primary_entry`. The kernel keeps X0 as its device tree pointer, turns on
   its MMU and calls `start_kernel` (`arch/arm64/kernel/head.S:60-61`,
   `:169-170`, `:521-533`, `:243`). On x86_64 a `bzImage` decompresses itself
   from its entry at `0x200` (`arch/x86/boot/compressed/head_64.S:285-288`,
   `:477`), and the kernel's `startup_64` calls `x86_64_start_kernel`
   (`arch/x86/kernel/head_64.S:38`, `:474`).
2. **Machine.** `start_kernel` reads the device tree or `boot_params` and the
   command line in `setup_arch` (`init/main.c:903`, `:925`).
3. **CPUs and devices.** `kernel_init_freeable` starts the other vCPUs in
   `smp_init`, then probes drivers in `do_basic_setup` (`init/main.c:1572`,
   `:1580`). The virtio-mmio probe reads each device's magic value and ID
   (`drivers/virtio/virtio_mmio.c:640`, `:656`), and each read is an MMIO exit
   to the VMM's device.
4. **Root and init.** `prepare_namespace` mounts `/dev/vdb` read-only as `/`
   (`init/main.c:1593`, `init/do_mounts.c:60-69`), and `kernel_init` executes
   the `init=` program as PID 1 (`init/main.c:594-605`, `:1509`).
5. **Agent.** `boxlite-guest` applies its sysctl hardening and forks its zygote
   before any thread (`src/guest/src/main.rs:106-120`). It then serves gRPC on
   vsock port 2695, connects to port 2696 to report ready, and waits for
   `Guest.Init` (`src/guest/src/service/server.rs:107-163`).

## Room for later milestones

- **M6, hot-plug mounts.**
  - One virtio-fs device serves every export, so a mount added at runtime is a
    new entry in the fs worker's export table, sent to it as a message.
  - No bus device, interrupt line or guest rescan is involved.
  - The jailed shim still needs access to the new host directory, for example
    as a descriptor passed from the runtime.
- **M7, dynamic resources.**
  - `vcpu_count` at boot is the maximum. The guest brings CPUs online and
    offline: PSCI `CPU_ON` and `CPU_OFF` on arm64, INIT and SIPI on x86_64.
  - A hotplug region directly above RAM is reserved at boot. virtio-mem adds
    and removes blocks in it with `map_memory` and `unmap_memory`.
- **M8, memory snapshots.**
  - The exit contract already requires pending I/O to finish before vCPU
    state is saved (`src/hypervisor/src/exit.rs`).
  - vCPU registers, interrupt-controller state (`hv_gic_state_*` on HVF, vgic
    attributes on KVM) and device state are plain data. They are serialised
    with serde, as in all four surveyed VMMs that take snapshots.
  - A restore maps the memory file copy-on-write through `map_memory`.
- **M9, GPU.**
  - BoxLite's own devices stay on virtio-mmio.
  - A PCI transport serves only passed-through devices, in the ECAM and BAR
    windows the layout reserves. On arm64, 32-bit BARs come from the unused
    part of the device window.
  - M9 adds an MSI call to `Vm` for those devices.
- **M10, Windows hosts.** `boxlite-hypervisor` reserves a `whp` module for WHP
  on Windows x86_64, and the [backend table](#hypervisor-backend-interface)
  lists its calls. It differs from HVF and KVM in three ways:
  - WHP emulates only local APICs, so the IOAPIC, PIC and PIT run in userspace
    and a raised line ends in `WHvRequestInterrupt`. M10 decides which crate
    owns them. OpenVMM keeps them in its chipset crate, which programs MSI
    routes into the backend (`vmm_core/virt/src/irqcon.rs:24-29`). When the
    guest ends a level-triggered interrupt, `WHvRunVpExitReasonX64ApicEoi`
    returns its vector to the WHP backend. Inside `Vcpu::run`, that backend
    forwards EOI to the userspace IOAPIC through a shared controller or
    callback, then resumes WHP; it does not return EOI as a `VcpuExit` to the
    VMM loop. M10 wires that controller interaction, as QEMU does inside its
    WHP exit handling (`target/i386/whpx/whpx-all.c:2332-2335`).
  - A memory-access exit gives the instruction bytes and the guest address,
    not the access width or data. The backend's `emulator` decodes the
    instruction, as OpenVMM does with its `x86emu` crate, so `MmioRead` and
    `MmioWrite` keep their shape.
  - An unrecoverable guest exception
    (`WHvRunVpExitReasonUnrecoverableException`) is `Error::UnhandledExit`,
    and QEMU pauses the VM on it (`target/i386/whpx/whpx-all.c:2684-2694`).
    KVM instead reports an x86 triple fault as `KVM_EXIT_SHUTDOWN`, which the
    backend maps to `Reset`. M10 decides whether WHP matches KVM.

## References

The survey behind the names and the layout, the exit contract, the boot path and
the M10 notes used these pinned sources:

| Project | Pin | Files |
| --- | --- | --- |
| [Firecracker](https://github.com/firecracker-microvm/firecracker/tree/68698adfee9b252df130b7a98e3ba04eb81f0f54) | `68698ad` | `src/vmm/src/vstate/`, `src/vmm/src/arch/*/layout.rs`, `src/vmm/src/arch/aarch64/regs.rs`, `src/vmm/src/arch/aarch64/vcpu.rs`, `src/vmm/src/arch/aarch64/fdt.rs`, `src/vmm/src/arch/x86_64/regs.rs`, `src/vmm/src/arch/x86_64/vcpu.rs`, `src/vmm/src/arch/x86_64/mod.rs`, `src/vmm/src/arch/x86_64/mptable.rs` |
| [crosvm](https://github.com/google/crosvm/tree/4c88690f44c382e34bdff7ad18ca10f8f9de6aa2) | `4c88690` | `hypervisor/src/lib.rs`, `devices/src/bus.rs`, `aarch64/src/lib.rs` |
| [OpenVMM](https://github.com/microsoft/openvmm/tree/998904f2debee98416c5d007a17f05be1b7dad34) | `998904f` | `vmm_core/virt_whp/src/`, `vmm_core/virt/src/irqcon.rs`, `vm/x86/x86emu/` |
| [cloud-hypervisor](https://github.com/cloud-hypervisor/cloud-hypervisor/tree/c24527002473dec810ef98fe3befb558ff2d5ede) | `c245270` | `hypervisor/src/`, `vm-device/src/bus.rs`, `arch/src/*/layout.rs`, `README.md` |
| [libkrun](https://github.com/libkrun/libkrun/tree/e12b9b3780ffa8df9f3e1797b217d13453479167) | `e12b9b3` | `src/hvf/src/lib.rs`, `src/vmm/src/builder.rs`, `init/init.c`, `src/devices/src/legacy/vcpu.rs`, `src/arch/src/x86_64/mod.rs`, `src/devices/src/fdt/aarch64.rs` |
| [alioth](https://github.com/google/alioth/tree/9d39a5d288fcd8630a24c5e762e4c31e97f1840f) | `9d39a5d` | `alioth/src/hv/hv.rs`, `alioth/src/arch/*/layout.rs` |
| [hyperlight](https://github.com/hyperlight-dev/hyperlight/tree/398e7957c194ef6227d79fa729fd8dd43e5dc117) | `398e795` | `src/hyperlight_host/src/hypervisor/virtual_machine/mod.rs` |
| [kvm-ioctls](https://github.com/rust-vmm/kvm-ioctls/tree/668b30b650c7032efcd1c3c82c065bd44036bea9) | `668b30b` | `kvm-ioctls/src/ioctls/vcpu.rs`, `kvm-ioctls/src/ioctls/vm.rs` |
| [applevisor](https://github.com/Impalabs/applevisor/tree/e39e718fdc8aef7c65efe091c54d6a50eb33537e) | `e39e718` | `src/vcpu.rs`, `src/gic.rs` |
| [dragonball (Kata Containers)](https://github.com/kata-containers/kata-containers/tree/68b56713d9fa37d4cf4613c775c78b14465eb7ab) | `68b5671` | `src/dragonball/src/vmm.rs`, `src/dragonball/crates/dbs_boot/` |
| [Linux](https://github.com/torvalds/linux/tree/v6.12) | `v6.12` | `Documentation/arch/arm64/booting.rst`, `Documentation/arch/x86/boot.rst`, `arch/arm64/kernel/head.S`, `arch/x86/boot/compressed/head_64.S`, `arch/x86/kernel/head_64.S`, `init/main.c`, `init/do_mounts.c`, `drivers/virtio/virtio_mmio.c`, `drivers/firmware/psci/psci.c`, `arch/arm64/kvm/psci.c`, `arch/arm64/kernel/cpuinfo.c`, `arch/x86/kernel/apic/apic.c`, `arch/x86/kernel/smpboot.c`, `arch/x86/kernel/mpparse.c`, `arch/x86/Kconfig` |
| [QEMU](https://github.com/qemu/qemu/tree/f8aef8a9aed7438083c400da10acabdec485dc9b) | `f8aef8a` | `accel/kvm/kvm-all.c`, `target/arm/hvf/hvf.c`, `target/i386/whpx/whpx-all.c` |

Host APIs:

- **HVF:** the Hypervisor.framework headers `hv_vcpu.h`, `hv_vcpu_types.h`, `hv_vm.h` and
  `hv_gic.h`, in the macOS SDK.
- **KVM:** the [KVM API](https://docs.kernel.org/virt/kvm/api.html).
- **WHP:** the
  [Windows Hypervisor Platform API](https://learn.microsoft.com/en-us/virtualization/api/hypervisor-platform/hypervisor-platform).
