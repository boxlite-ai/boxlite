# boxlite-vmm

BoxLite's native VMM. `Vm::new` validates the machine configuration, creates
the host VM and registers guest RAM. The crate-visible VM and vCPU `run` entry
points still sketch event dispatch, guest exits, and worker cleanup with inline
`todo!()` operations that panic if called; vCPU exits use
`boxlite_hypervisor::VcpuExit`, and `Error` wraps `boxlite_hypervisor::Error`
with its cause chain intact. This crate cannot boot a kernel yet. The
[VMM design](../../docs/contributing/architecture/vmm/README.md) specifies the
lifecycle API, memory layout, buses, interrupts, and threads it will implement.

The lifecycle types and `Error` remain crate-visible while those entry points
are placeholders. M1 will make the implemented `Vm`, `VmExit`, `Error` and
`Result` public together; M2's engine adapter will then consume that API and
inspect the error's host cause.

```text
boxlite-vmm
├── boxlite-hypervisor
├── mio (the event loop's poller)
├── vm-memory
├── vm-superio (x86_64: the 8250 UART and the i8042, 0.8.2 or later)
└── linux-loader (Linux x86_64 ELF loading and boot parameters)
```

| Module | Planned responsibility |
| --- | --- |
| `vm` | `Vm<H>`: validate the configuration, then allocate and register RAM on host backend `H`; `run` is a placeholder |
| `config` | `VmConfig { vcpu_count, memory_mib, kernel, cmdline, initramfs }` and its bounds: 1..=64 vCPUs, 1..=3072 MiB, a printable-ASCII command line under 2048 bytes |
| `error` | VMM errors that keep the hypervisor's cause chain |
| `memory` | `GuestRam`: owned guest RAM, the RAM layout, and the registration lifetime rules |
| `boot` | Linux x86_64 boot: `prepare` loads the pinned ELF kernel through linux-loader, places an optional initramfs at the top of RAM, writes the zero page, E820 map and command line, and sets up the 64-bit entry state (GDT, identity page tables, registers); the MP table follows |
| `cpu_features` | x86_64 guest CPUID for each vCPU and the boot MSRs |
| `vcpu` | Worker threads, stop coordination, and exit handling |
| `irq` | `IrqChip`, the host interrupt controller as devices see it, and `IrqLine`, one device line that raises edges; HVF and KVM provide the controller, WHP (M10) only local APICs |
| `bus` | `Bus`, `BusRange` and `BusDevice`, and `Buses::dispatch`, which serves the MMIO and port exits of a vCPU |
| `events` | `Event` (`GuestReset`, `DeviceFailed`), `EventSender`, and `EventLoop`, the poller the `run()` thread will wait on |
| `devices` | x86_64 legacy devices on the port bus (the 8250 UART, the CMOS RTC and the i8042 reset) and `DeviceManager`, which owns them |

Backend implementation and guest boot follow in M1. Virtio devices, the BoxLite
engine adapter, engine selection, and `native` feature wiring follow in M2.
Neither new crate depends on `boxlite-shared`, and both are unpublished while
their interfaces are being established.

## Guest RAM

`memory::ram_ranges` places one region: at guest address 0 on x86_64, below
the 32-bit MMIO hole at `0xC000_0000`, and at `0x8000_0000` on arm64. The
3072 MiB bound keeps every layout inside that region; the region above 4 GiB
and the arm64 address-space limit are later changes.

`GuestRam` allocates the layout as zero-filled anonymous memory through
vm-memory and registers it with the host VM. Three rules keep the backend's
`map_memory` contract:

- Host-side users clone the shared `Arc<GuestMemoryMmap>` and access guest
  memory through vm-memory's volatile API, never through Rust references.
- `map` registers regions lowest address first and removes the registered
  prefix when one fails; `unmap` removes them highest first and stops at the
  first failure, so the count of registered regions stays exact and a later
  `unmap` retries.
- The backing is released only after every registration is gone. Dropping a
  `GuestRam` that may still be registered leaks the backing instead.

`Vm::with_backend` runs validate, allocate, create the host VM, then map, so
every early return drops the host VM before the RAM; `Vm`'s `Drop` unmaps as a
backstop. Unit tests drive these paths with a recording mock backend. The
`memory` and `vm` tests and that backend live in `tests/` and are included as
unit-test modules, which keeps them outside the counted sources and the
coverage denominator; `config` and `error` keep inline test modules.

## Kernel loading

On Linux x86_64, `boot::elf::load_elf(ram, kernel)` delegates ELF parsing and
segment loading to rust-vmm's linux-loader and returns the entry and end
addresses as `io::Result<LoadedKernel>`. The end covers the segments
linux-loader copies, BSS tails included; it skips segments without file
bytes, which the pinned kernel does not have. It reads `kernel` through a seekable reader, usually the
kernel file, so segments go straight into guest RAM without buffering the
whole image. It uses vm-memory 0.18 and linux-loader 0.14 with only the ELF
feature. The function stays crate-visible until the lifecycle slice wires
it into `Vm::new`; the VM cannot boot Linux yet.

Pass the pinned `vmlinux` from `make vmm:boot` and fresh zero-filled guest
RAM before guest execution. BSS relies on that initial zero state. Validation
and copying follow the library's behavior; a failed load may have changed RAM,
so discard that RAM before retrying.

The hardware probe requires Linux x86_64, read/write `/dev/kvm`, binutils
`readelf`, and a `vmlinux` whose segments fit in its 128 MiB of RAM:

```sh
make vmm:boot
make test:integration:vmm:elf
# To qualify a different artifact:
make test:integration:vmm:elf VMM_KERNEL=/absolute/path/to/vmlinux
```

`VMM_KERNEL` defaults to `target/vmm/boot/x86_64/vmlinux`. The probe compares
the entry and loaded bytes with independent `readelf` output, checks BSS in
fresh RAM, then runs a vCPU checksum over the loaded span. Missing hardware
or kernel input fails qualification. This proves loading and guest visibility;
the [boot tests](#boot-tests) run Linux itself.

## Boot parameters

On Linux x86_64, `boot::params::write_boot_params(ram, cmdline, ranges,
initramfs)` fills the zero page that RSI points to at the 64-bit entry
(`Documentation/arch/x86/boot.rst`, `zero-page.rst`) and returns its address,
`0x7000`:

- Setup header: `type_of_loader` `0xFF`, `boot_flag` `0xAA55`, the `HdrS`
  magic, a 16 MiB `kernel_alignment`, and `cmd_line_ptr` and `cmdline_size`
  for the NUL-terminated command line at `0x2_0000`, plus `ramdisk_image` and
  `ramdisk_size` when there is an initramfs. The rest stays zero: no
  `loadflags` or ACPI tables.
- E820: each RAM range as usable RAM outside `[0x9_FC00, 1 MiB)`, where the
  MP table and the legacy BIOS areas go. More entries than the 128 table slots
  fail with `InvalidInput` before anything is written.

`VmConfig::validate` accepts a command line only if it is printable ASCII and
shorter than 2048 bytes, the kernel's `COMMAND_LINE_SIZE` with the NUL.
linux-loader's `Cmdline` refuses the same lines, after trimming surrounding
whitespace.

`boot::prepare(ram, config)` opens `config.kernel` and runs `load_elf`, then
`load_initramfs` when `config.initramfs` is set, then `write_boot_params` and
`long_mode_entry`, in that order on fresh RAM, and returns a `BootSetup` with
the boot vCPU registers. A failure names its step, `LoadKernel`,
`LoadInitramfs` or `WriteBootData`, and keeps the I/O cause. Nothing calls
`prepare` from `Vm` yet. There is no MP table yet, so Linux turns off SMP and
the IOAPIC; a later slice adds the table.

## Initramfs

`boot::initramfs::load_initramfs(ram, image, size, kernel_end)` reads the
archive into the highest 4 KiB-aligned slot of the RAM region at 0, as
Firecracker and cloud-hypervisor do, and returns its start. An empty archive,
or one whose slot would begin below the page-aligned kernel end, fails with
`InvalidInput` before anything is written. Linux ignores `initrd_addr_max`, so
the archive may sit anywhere in RAM; it must be uncompressed newc, since the
pinned kernel has no decompressors. With 256 MiB of RAM, a 372-byte archive
starts at `0x0FFF_F000` and Linux prints `RAMDISK: [mem 0x0ffff000-0x0fffffff]`.

## Boot tests

The boot tests need Linux x86_64, read/write `/dev/kvm` and the same
`VMM_KERNEL` as the ELF probe:

```sh
make test:integration:vmm:linux
```

Each runs `prepare` for 256 MiB of RAM, then runs one KVM vCPU with the guest
CPUID and boot MSRs on the [legacy devices](#legacy-devices-and-events), with
the CMOS RTC stopped at 2026-01-02T03:04:05Z. The test thread dispatches every
exit to the buses and stops at the first event. A watchdog kicks the vCPU at
the timeout, 30 seconds unless stated, so a hung boot fails with the serial
log so far.

- With `earlycon=uart8250,io,0x3f8 keep_bootcon panic=-1 reboot=k` and no
  initramfs, the log must show the kernel version, the exact command line,
  the two E820 entries, the memory total and `VFS: Unable to mount root fs`.
- With the same command line and a generated archive whose `/init`, a
  132-byte static ELF, calls `exit_group(42)`, the log must show the
  `RAMDISK:` range from the zero page, `Unpacking initramfs...`,
  `Run /init as init process` and
  `Attempted to kill init! exitcode=0x00002a00`, in that order.
- With `console=ttyS0 panic=-1 reboot=k` and an `/init` that prints a line,
  waits for the tty to send it and restarts the machine, the log must show
  the 16550A on IRQ 4, `rtc_cmos rtc_cmos: setting system clock to
  2026-01-02T03:04:05 UTC (1767323045)`, that line and
  `reboot: Restarting system`, in that order, and GSI 4 must have been raised.
- The same boot with every interrupt dropped must log
  `Run /init as init process` but not the start of `/init`'s line, and end at
  a 3-second timeout. Against vm-superio 0.8.1 it fails: the first 16 bytes
  leave without IRQ 4.

Each run but the last must end with `GuestReset`: `panic=-1 reboot=k` turns a
panic, and the restart, into the i8042 reset.

## Long-mode entry

On Linux x86_64, `boot::entry::long_mode_entry(ram, entry, boot_params)`
writes the state that the Linux 64-bit boot protocol requires
(`Documentation/arch/x86/boot.rst`, "64-bit Boot Protocol") and returns the
boot vCPU registers. vCPU workers will apply them after the vCPU's CPUID and
MSRs; nothing calls it from `Vm` yet.

- Guest RAM: the GDT at `0x500` holds flat `__BOOT_CS` (`0x10`) and
  `__BOOT_DS` (`0x18`). Page tables from `0x9000` identity-map
  `[0, MMIO_HOLE_START)`, where all RAM lies, with 2 MiB pages, whatever the
  RAM size, and leave the hole unmapped. Nothing is written unless RAM covers
  `0x500..0xE000`.
- Registers: 64-bit mode with paging (CR0 PE, ET and PG; CR4 PAE; EFER LME
  and LMA), interrupts off, RIP at `entry`, RSI at `boot_params`, a stack
  below `0x8FF0`, and segments decoded from the GDT entries. There is no IDT,
  so an exception before Linux installs its own resets the guest.

## CPU features

`cpu_features::guest_cpuid(supported, index, count)` turns KVM's supported
CPUID into vCPU `index`'s. KVM passes the host's APIC ID through and reports
no topology, so it sets:

- leaf 1: APIC ID `index`, `count` rounded up to a power of two, HTT when
  `count > 1`, and the hypervisor and TSC-deadline bits;
- leaf 0xB, and 0x1F when KVM lists it: an SMT level of one thread and a
  core level of `count` cores whose shift of 6 covers every APIC ID up to 64;
- on AMD and Hygon, 0x8000_001E (APIC and core ID `index`, node 0) and
  0x8000_0008 ECX (ApicIdSize 6, `count - 1` more cores).

Every other entry is kept, so vCPUs differ only in their APIC ID.
`BOOT_MSRS` adds FAST_STRING to KVM's MISC_ENABLE and enables MTRRs with a
write-back default; KVM already creates the other boot MSRs as zero. The
local APIC keeps its KVM reset state, with LINT0 in ExtINT mode on the boot
vCPU; Linux programs LINT1 itself.

## Buses and interrupt lines

`bus::Buses` holds an MMIO bus on every host and a port bus on x86_64.
`Buses::dispatch` takes a vCPU exit, serves `MmioRead`, `MmioWrite`, `IoIn`
and `IoOut`, and returns every other exit to the caller. A device registers a
`BusRange` and sees offsets from its base:

- An access must lie entirely inside one range. An access that no device
  holds, that crosses a range end, or whose device was dropped reads `0xFF`
  and its write is dropped, as on a PC bus with nothing driving it.
- Reads reach the device zero-filled, so a device that fills part of the
  buffer never leaks what the hypervisor left in it.
- `BusRange::new` rejects empty and wrapping ranges and `insert` rejects
  overlapping ones, both with `Overlap`.
- Buses hold `Weak` references; the device manager owns the devices.
- A device whose lock an earlier panic poisoned stops the next access too,
  as in Firecracker and cloud-hypervisor: that panic was a VMM bug, since no
  guest input may panic the VMM.

`irq::IrqLine` is one device interrupt line over `IrqChip`, which every host
VM implements through `Vm::set_irq_line`. `pulse` raises an edge, a set
followed by a clear. `IrqLine` is not `Clone`, so a device cannot share its
line; the device manager creates one per line. On x86_64,
[`DeviceManager`](#legacy-devices-and-events) registers the devices and gives
the serial port its line; no VM creates it yet.

## CMOS RTC

On x86_64, `devices::cmos::CmosRtc` is the MC146818 behind ports `0x70`
(index) and `0x71` (data). Linux reads it once at boot through
`RTC_HCTOSYS`; the boot wall clock itself comes from kvmclock.

- The time is an injected clock, the host wall clock outside tests, plus an
  offset that keeps any time the guest sets.
- As in QEMU, the time registers hold still while register B's SET bit or a
  divider reset in register A stops the clock.
- On any release the written time resumes half a second into its second,
  because Linux writes half a second early (`set_offset_nsec` in
  `rtc-cmos.c`). QEMU adds the half second only when the divider restarts
  and otherwise keeps the old phase, which would put a Linux write on AMD,
  where only SET is used, up to half a second off.
- A write while the clock runs takes effect at once.
- Time registers read in BCD unless register B selects binary. Only 24-hour
  mode is modelled, so register B always reads with that bit set.
- Register A starts at `0x26` and never reports an update in progress;
  register C reads 0 and register D reads `0x80`. The remaining bytes are
  NVRAM.
- Linux writes the century byte only through ACPI, so a two-digit year
  00–69 means 20xx and 70–99 means 19xx unless the guest writes it.
- There is no IRQ 8, so alarm, update and periodic interrupts never fire:
  `hwclock` in the guest waits 10 s for an update interrupt and fails.

## Legacy devices and events

On x86_64, `devices::DeviceManager::new` creates the legacy devices,
registers them on the port bus, and owns them:

| Ports | Device | Behaviour |
| --- | --- | --- |
| `0x3F8`–`0x3FF` | `Serial8250`, vm-superio's 16550A | Output goes to a host sink; a pending, enabled THRE or RDA raises an edge on GSI 4; no input yet |
| `0x70`–`0x71` | `CmosRtc` | See [CMOS RTC](#cmos-rtc) |
| `0x60`, `0x64` | `I8042Port`, over vm-superio's i8042 | Reads 0; the first `0xFE` at `0x64` sends `GuestReset` |

- vm-superio must be 0.8.2 or later. It raises THRE on every IER write, so
  Linux's 8250 driver passes its THRE and TXEN probes and sends tty output on
  IRQ 4. Against 0.8.1 the driver enables `UART_BUG_TXEN` and sends 16 bytes
  without the interrupt.
- A sink write that fails drops the byte and counts it
  (`serial_dropped_bytes`); THRE still rises, so the guest keeps sending. A
  failed interrupt sends `DeviceFailed`, once.
- The ports between `0x60` and `0x64` are not the i8042's: KVM's in-kernel
  PIT serves `0x61`. The guest kernel has no i8042 driver, so the reset is
  all the device does.

`events::EventLoop` owns a mio poller. Devices and vCPU threads `send` an
`Event` through an `EventSender`, which queues it and wakes the poller;
`wait(timeout)` returns the oldest event, and a zero timeout never enters the
poller. Each device sends at most one event, so a guest cannot grow the
queue.

## Build

`make vmm:boot` builds the pinned x86_64 ELF kernel (`vmlinux`) inside a pinned
BoxLite box; `make vmm:boot:host` uses Linux host tools instead. See
[boot](boot/README.md) for prerequisites, outputs and limits.

From the repository root:

```sh
make vmm
make clippy:vmm
make test:unit:vmm
make fmt:check:rust
```

On Linux x86_64 with read/write access to `/dev/kvm`,
`make test:integration:vmm:kvm` also runs this crate's hardware tests on VMs
with the largest layout. A flat 32-bit guest reads the last RAM byte and
reports it on port `0x3f8`. A 64-bit guest entered through
`long_mode_entry`, with `guest_cpuid` and `BOOT_MSRS` applied, reloads its
segments from the GDT in RAM, reads markers at RSI and at the top of RAM, and
stores RFLAGS, CR0, CR3, CR4, EFER, CPUID leaves 1 and 0xB, MISC_ENABLE and
MTRRdefType for the test to compare. The 3 GiB allocation is `MAP_NORESERVE`, so only the touched
pages are committed; a host with `vm.overcommit_memory=2` refuses it. CI runs
the same tests through `make coverage:vmm:kvm`.

With the corresponding Rust targets installed, the crate can also be compiled
for each host with a backend module without booting a VM:

```sh
CARGO_BUILD_TARGET=aarch64-apple-darwin make vmm
CARGO_BUILD_TARGET=x86_64-unknown-linux-gnu make vmm
CARGO_BUILD_TARGET=aarch64-unknown-linux-gnu make vmm
CARGO_BUILD_TARGET=x86_64-pc-windows-msvc make vmm
```

The existing Clippy CI matrix compiles workspace crates on the first three
hosts. No CI job compiles the Windows target, whose `whp` module is reserved
for M10.
