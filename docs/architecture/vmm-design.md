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

Repository line references are to commit `42ec1a2a6`. `libkrun/` is the vendored
copy at `src/deps/libkrun-sys/vendor/libkrun/` (upstream `e12b9b3`).

## Scope

- **In scope:**
  - one VM per shim process, on macOS arm64 (Hypervisor.framework, "HVF") and
    on Linux x86_64 and arm64 (KVM);
  - boxes that work as they do on libkrun (M0–M5); the
    [guest boot contract](#guest-boot-contract) lists what changes underneath;
  - room for hot-plug mounts, dynamic resources, memory snapshots and GPUs
    (M6–M9).
- **Out of scope:** more than one VM per process, confidential computing, live
  migration, Intel Macs, Windows hosts (M10), and changes to libkrun.

## Decisions

| Decision | Choice | Why | Rejected |
| --- | --- | --- | --- |
| Minimum macOS | 15, using HVF's in-kernel GICv3 | `hv_gic_create` and `hv_gic_set_spi` exist from macOS 15.0 (`hv_gic.h`), so no host needs an emulated interrupt controller, and libkrun already prefers the in-kernel GIC wherever the host has it | macOS 12 with a userspace GICv3, which libkrun falls back to below macOS 15 (`libkrun/src/vmm/src/builder.rs:892-894`), at about 3–4 engineer-weeks in M1 |
| SHARED share | virtio-fs in two stages: a FUSE server core for the SHARED share in M2, full passthrough for user volumes in M3 | Every box mounts the SHARED share, and guest file copy stages through it, so the first box already needs virtio-fs | Moving container layout and file copy off the SHARED share first, which changes the guest agent before the first box boots |
| Threads | One thread per vCPU, worker threads per device, and a poller on the thread that calls `run()` | HVF binds a vCPU to the thread that created it, and per-device workers keep a slow device, such as a blocking virtio-fs request, from stalling the others | One event loop for all devices (Firecracker), where one slow device stalls the rest; an async runtime inside the jailed shim, which complicates per-thread seccomp |

macOS 12–14 keep running boxes on libkrun until M5. When M5 removes libkrun,
the support matrix in `README.md:241` changes from "macOS 12+" to macOS 15.

## Architecture

```text
boxlite-shim                    one jailed process per box
└─ engine adapter (M2)          implements Vmm and VmmInstanceImpl (src/boxlite/src/vmm/engine.rs:51-104)
   └─ boxlite_vmm::Vm           new(config), then run() → VmExit or Error
      ├─ vcpuN threads          Vcpu::run → VcpuExit → bus dispatch → run again
      ├─ device workers         virtqueues and host backends: disk, fs, vsock, net, console
      ├─ the run() thread       one poller: stop requests, vCPU outcomes, device failures
      └─ boxlite_hypervisor     Vm and Vcpu traits; hvf (macOS arm64) or kvm (Linux)
guest
└─ pinned LTS kernel → boxlite-guest as PID 1
```

The two crates split the work as follows:

- **`boxlite-hypervisor`** owns what differs between hosts: VM and vCPU handles,
  memory registration, interrupt injection, and decoding exits.
- **`boxlite-vmm`** owns the guest machine: configuration, memory layout,
  devices, threads, and lifecycle.

KVM memory slots stay inside the KVM backend and ARM exception syndromes stay
inside the HVF backend, so `boxlite-vmm` never sees either.

## Hypervisor backend interface

The backend is chosen at compile time, because HVF and KVM never coexist on one
host. M1 adds one concrete type per backend, `HvfVm` and `KvmVm`, and both
implement the traits in `src/hypervisor/src/`. `boxlite-vmm` is written against
those traits, so its tests can drive a fake backend, and M4's fault-injection
tests need no hypervisor.

| Operation | Contract | HVF | KVM |
| --- | --- | --- | --- |
| Map guest memory | `Vm::map_memory` (`unsafe`) | `hv_vm_map` | `KVM_SET_USER_MEMORY_REGION`; the backend picks the slot |
| Unmap guest memory | `Vm::unmap_memory` | `hv_vm_unmap` | the same slot, set to size 0 |
| Create a vCPU | `Vm::create_vcpu`, on the thread that will run it | `hv_vcpu_create` | `KVM_CREATE_VCPU` |
| Run to the next exit | `Vcpu::run` → `VcpuExit` | `hv_vcpu_run` | `KVM_RUN` |
| Kick from another thread | `VcpuHandle::kick` | `hv_vcpus_exit` | set `immediate_exit`, then signal the vCPU thread |
| Set an interrupt line | `Vm::set_irq_line` | `hv_gic_set_spi` | `KVM_IRQ_LINE` |

Every backend keeps these rules:

- **Creation.**
  - The backend's constructor creates the VM and the host's in-kernel
    interrupt controller and timer: a GICv3 on arm64; the PIC, IOAPIC, local
    APICs and PIT on x86_64, as libkrun creates them
    (`libkrun/src/devices/src/legacy/kvmioapic.rs:19-25`).
  - HVF needs its GIC before any vCPU exists (`hv_gic.h`), and so does KVM's
    x86 irqchip.
  - KVM on arm64 initialises its GIC only after every vCPU exists, so that
    backend initialises it on the first `run`.
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
    nothing but that guest region, until `unmap_memory` for it succeeds or
    the VM and all its vCPUs drop. A failed unmap can leave the guest mapping
    in place, and on KVM a live vCPU keeps the VM's mappings alive.
  - The guest changes that memory at any time, so VMM code such as a virtqueue
    touches it only through raw pointers or volatile accesses, never through
    Rust references.
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

`VcpuExit` (`src/hypervisor/src/exit.rs`) is what `run` returns. MMIO and port
data borrow a per-vCPU buffer inside the backend, as in libkrun and kvm-ioctls.
The VMM therefore handles an exit before it runs that vCPU again, and the next
`run` completes the guest's instruction.

| Exit | Meaning | Source |
| --- | --- | --- |
| `MmioRead`, `MmioWrite` | Access to an emulated device | HVF data abort; `KVM_EXIT_MMIO` |
| `IoIn`, `IoOut` (x86_64 only) | One port access to the 8250 serial, CMOS RTC or i8042; string port I/O is `Error::UnhandledExit` | `KVM_EXIT_IO` |
| `Interrupted` | A kick | `hv_vcpus_exit`; `KVM_RUN` returning `EINTR` |
| `Halted` | The vCPU waits for an interrupt | HVF traps `WFI`; KVM with the in-kernel irqchip waits in the kernel, and the backend still maps `KVM_EXIT_HLT`, which only a VM without one returns (as the probe VM in `src/boxlite/src/system_check.rs` does) |
| `Shutdown` | The guest powered off | PSCI `SYSTEM_OFF`, decoded by the HVF backend; `KVM_EXIT_SYSTEM_EVENT` |
| `Reset` | The guest reset | PSCI `SYSTEM_RESET`, decoded by the HVF backend and a `KVM_EXIT_SYSTEM_EVENT` reset on KVM arm64; an x86 triple fault (`KVM_EXIT_SHUTDOWN`) |

On x86_64 the guest resets through the i8042 port. That reset arrives as an
`IoOut`, and the VMM's i8042 device turns it into the end of the VM.

KVM handles PSCI `CPU_ON` for secondary vCPUs in the kernel. On HVF the backend
decodes the call, and M1 adds an exit so the VMM can start the target vCPU.

## Device model

### Guest memory layout

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
| `0x10_0000` | kernel load address | four of six |
| below `0xC000_0000`, and above 4 GiB | RAM, split around the 32-bit MMIO hole | Firecracker, cloud-hypervisor, dragonball |
| `0xC000_0000`–`0xD000_0000` | 32-bit PCI BAR window, reserved for M9 | Firecracker, cloud-hypervisor and alioth give PCI BARs space in the hole |
| `0xD000_0000`–`0xE000_0000` | virtio-mmio devices, 4 KiB each, with interrupts from GSI 5 | device window: libkrun, crosvm; GSI 5: Firecracker, libkrun, dragonball |
| `0xE000_0000`–`0xF000_0000` | PCI ECAM, reserved for M9 | alioth |
| `0xFEC0_0000`, `0xFEE0_0000` | IOAPIC and local APIC, both in the kernel | architectural |
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

- **No emulated controller.** Every host provides an in-kernel interrupt
  controller, so the VMM emulates none.
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
  - Each is named `vcpuN`. It creates its vCPU and waits until every vCPU
    exists.
  - It then loops: run, dispatch the exit to a bus, run again.
  - On `Halted`, which in practice only HVF returns, it parks until the guest timer's
    deadline, an interrupt, or a stop.
  - The VMM's interrupt path unparks halted vCPUs after it sets a line;
    `Vm::set_irq_line` itself wakes no thread. M1 decides how an IPI from
    another vCPU wakes a parked one.
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

Leaving libkrunfw drops three kinds of kernel patch:

- **Turning init's death into a reboot.** An agent that never exits, plus
  `panic=-1`, replaces it.
- **vsock datagrams.** The macOS clock resync uses them.
- **TSI.** Unused: the network factory always returns gvproxy
  (`src/boxlite/src/net/mod.rs:481-484`).

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

## References

The survey behind the names and the layout used these pinned sources:

| Project | Pin | Files |
| --- | --- | --- |
| [Firecracker](https://github.com/firecracker-microvm/firecracker/tree/68698adfee9b252df130b7a98e3ba04eb81f0f54) | `68698ad` | `src/vmm/src/vstate/`, `src/vmm/src/arch/*/layout.rs` |
| [crosvm](https://github.com/google/crosvm/tree/4c88690f44c382e34bdff7ad18ca10f8f9de6aa2) | `4c88690` | `hypervisor/src/lib.rs`, `devices/src/bus.rs`, `aarch64/src/lib.rs` |
| [cloud-hypervisor](https://github.com/cloud-hypervisor/cloud-hypervisor/tree/c24527002473dec810ef98fe3befb558ff2d5ede) | `c245270` | `hypervisor/src/`, `vm-device/src/bus.rs`, `arch/src/*/layout.rs` |
| [libkrun](https://github.com/libkrun/libkrun/tree/e12b9b3780ffa8df9f3e1797b217d13453479167) | `e12b9b3` | `src/hvf/src/lib.rs`, `src/vmm/src/builder.rs`, `init/init.c` |
| [alioth](https://github.com/google/alioth/tree/9d39a5d288fcd8630a24c5e762e4c31e97f1840f) | `9d39a5d` | `alioth/src/hv/hv.rs`, `alioth/src/arch/*/layout.rs` |
| [hyperlight](https://github.com/hyperlight-dev/hyperlight/tree/398e7957c194ef6227d79fa729fd8dd43e5dc117) | `398e795` | `src/hyperlight_host/src/hypervisor/virtual_machine/mod.rs` |
| [kvm-ioctls](https://github.com/rust-vmm/kvm-ioctls/tree/668b30b650c7032efcd1c3c82c065bd44036bea9) | `668b30b` | `kvm-ioctls/src/ioctls/vcpu.rs`, `kvm-ioctls/src/ioctls/vm.rs` |
| [applevisor](https://github.com/Impalabs/applevisor/tree/e39e718fdc8aef7c65efe091c54d6a50eb33537e) | `e39e718` | `src/vcpu.rs`, `src/gic.rs` |
| [dragonball (Kata Containers)](https://github.com/kata-containers/kata-containers/tree/68b56713d9fa37d4cf4613c775c78b14465eb7ab) | `68b5671` | `src/dragonball/src/vmm.rs`, `src/dragonball/crates/dbs_boot/` |
| [QEMU](https://github.com/qemu/qemu/tree/f8aef8a9aed7438083c400da10acabdec485dc9b) | `f8aef8a` | `accel/kvm/kvm-all.c`, `target/arm/hvf/hvf.c` |

Host APIs:

- **HVF:** the Hypervisor.framework headers `hv_vcpu.h`, `hv_vm.h` and
  `hv_gic.h`, in the macOS SDK.
- **KVM:** the [KVM API](https://docs.kernel.org/virt/kvm/api.html).
