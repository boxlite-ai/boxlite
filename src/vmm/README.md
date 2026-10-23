# boxlite-vmm

BoxLite's native VMM. On Linux x86_64, `Vm::new` validates the machine
configuration, creates the KVM VM, registers guest RAM and loads the kernel and
boot data; `Vm::run` runs every vCPU until the guest powers off or resets, or a
`StopHandle` stops it, and returns how the VM ended (see [Lifecycle](#lifecycle)).
`Error` wraps `boxlite_hypervisor::Error` with its cause chain intact. The
[VMM design](../../docs/contributing/architecture/vmm/README.md) specifies the
lifecycle API, memory layout, buses, interrupts, and threads.

`Vm`, `VmConfig`, `VmExit`, `StopHandle`, `Error` and `Result` are public, as
are `BusKind` and `Conflict`, which `Error::ChipsetConflicts` carries; M2's
engine adapter will consume that API and inspect the error's host cause.
`Vm::new` adds no device to its chipset yet, so it boots a guest without a
console.

```text
boxlite-vmm
├── boxlite-hypervisor
├── mio (the event loop's poller)
├── vm-memory
├── vm-superio (x86_64: the 8250 UART and the i8042, 0.8.2 or later)
└── linux-loader (Linux x86_64 ELF loading and boot parameters)
```

| Module | Responsibility |
| --- | --- |
| `vm` | `Vm<H>`: validate the configuration, allocate and register RAM on host backend `H`, own the devices in a `Chipset`, load the boot data, and run the vCPUs until the first event; `StopHandle` and `VmExit` |
| `boot` | Linux x86_64 boot: `prepare` loads the pinned ELF kernel through linux-loader, places an optional initramfs at the top of RAM, writes the zero page, E820 map, command line and MP table, and sets up the 64-bit entry state (GDT, identity page tables, registers) |
| `config` | `VmConfig { vcpu_count, memory_mib, kernel, cmdline, initramfs }` and its bounds: 1..=64 vCPUs, 1..=3072 MiB, a printable-ASCII command line under 2048 bytes |
| `error` | VMM errors that keep the hypervisor's cause chain |
| `memory` | `GuestRam`: owned guest RAM, the RAM layout, and the registration lifetime rules |
| `cpu_features` | x86_64 guest CPUID for each vCPU and the boot MSRs |
| `vcpu` | x86_64 vCPU workers: create and configure each vCPU, hold them at a start gate, run the guest and dispatch its exits until the VM ends |
| `chipset` | `ChipsetBuilder`, the one registry of ranges and interrupt lines, and `Chipset`, the read-only machine it builds |
| `bus` | `Bus`, `BusRange` and `BusDevice`, and `Buses::dispatch`, which serves the MMIO and port exits of a vCPU |
| `irq` | `IrqChip`, the host interrupt controller as devices see it, and `IrqLine`, one device line; HVF and KVM provide the controller, WHP (M10) only local APICs |
| `devices` | The console queue, and on x86_64 the 8250 UART at COM1, the CMOS RTC and the i8042 reset, with `add_legacy_devices`, which adds them to the chipset |
| `events` | `Event`, which ends the VM, `EventSender`, which also latches the stop, and `EventLoop`, the poller that waits for the first event |

The x86_64 KVM boot and lifecycle are in place; the M1 devices, arm64 and HVF
follow in M1. Virtio devices, the BoxLite
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
segment loading to rust-vmm's linux-loader and returns the entry address as
`io::Result<u64>`. It reads `kernel` through a seekable reader, usually the
kernel file, so segments go straight into guest RAM without buffering the
whole image. It uses vm-memory 0.18 and linux-loader 0.14 with only the ELF
feature. `boot::prepare` calls it for `Vm::new`.

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
`load_initramfs` when `config.initramfs` is set, then `write_boot_params`,
`write_mptable` and `long_mode_entry`, in that order on fresh RAM, and returns
a `BootSetup` with the boot vCPU registers. A failure names its step,
`LoadKernel`, `LoadInitramfs` or `WriteBootData`, and keeps the I/O cause.
`Vm::new` calls `prepare` once RAM is registered.

## MP table

Without ACPI, Linux learns the vCPUs and the IOAPIC from the MP table, and
turns off SMP and the IOAPIC without one. `boot::mptable::write_mptable(ram,
vcpu_count)` writes the floating pointer at `0x9_FC00`, where Linux scans the
last KiB below 640 KiB, and the configuration table right after it. It lists
the same entries as Firecracker:

- one processor per vCPU, with APIC ID equal to its index as `vcpu_cpuid`
  assigns it, and vCPU 0 as the bootstrap processor;
- an ISA bus and KVM's in-kernel IOAPIC at `0xFEC0_0000` with ID
  `vcpu_count + 1`;
- ISA IRQ k on IOAPIC pin k for 0 to 23, the GSI routing KVM sets up;
- ExtINT on the boot vCPU's LINT0 and NMI on every LINT1.

The table takes 284 bytes plus 20 per vCPU, 1564 at 64, all inside the
reserved `[0x9_FC00, 1 MiB)`. With it Linux enables the IOAPIC even on one
vCPU, so device interrupts such as the serial IRQ 4 arrive through IOAPIC pins
instead of the PIC. The other vCPUs then start when Linux sends them INIT and
SIPI; on KVM each waiting vCPU's `run` returns `Interrupted` once, for the
`EAGAIN` that wake-up produces.

## Initramfs

`boot::initramfs::load_initramfs(ram, image, size)` reads the archive into the
highest 4 KiB-aligned slot of the RAM region at 0, as Firecracker and
cloud-hypervisor do, and returns its start. An empty archive, or one larger
than that region, fails with `InvalidInput` before anything is written.

Like those VMMs, it does not check that the slot stays clear of the kernel.
Only tests boot an initramfs; production boots from a disk. Their inputs are
fixed, and the KVM boot test below fails if the archive overwrites the kernel.
Accepting an initramfs from production configuration would need that check.

Linux ignores `initrd_addr_max`, so
the archive may sit anywhere in RAM; it must be uncompressed newc, since the
pinned kernel has no decompressors. With 256 MiB of RAM, a 372-byte archive
starts at `0x0FFF_F000` and Linux prints `RAMDISK: [mem 0x0ffff000-0x0fffffff]`.

## Boot tests

Unit tests read the generated boot data back from guest RAM. Hardware boot
tests are ignored by default and run explicitly through the target below.

The boot tests need Linux x86_64, read/write `/dev/kvm` and the same
`VMM_KERNEL` as the ELF probe:

```sh
make test:integration:vmm:linux
```

Each builds a KVM `Vm` with `prepare` for 256 MiB of RAM on the
[legacy devices](#legacy-devices-and-the-console), with the CMOS RTC stopped
at 2026-01-02T03:04:05Z, and runs it with `Vm::run`. The host VM is KVM behind a test wrapper that counts the edges
devices raise on GSI 4 and can drop every interrupt. A watchdog stops a boot
at its timeout, 30 seconds unless stated, so a failed boot reports the serial
log so far.

- With `earlycon=uart8250,io,0x3f8 keep_bootcon panic=-1 reboot=k`, one
  vCPU and no initramfs, the log must show the kernel version, the exact
  command line, the two E820 entries, the memory total and
  `VFS: Unable to mount root fs`.
- With the same command line, one vCPU and a generated archive whose
  `/init`, a 132-byte static ELF, calls `exit_group(42)`, the log must show
  the `RAMDISK:` range from the zero page, `Unpacking initramfs...`,
  `Run /init as init process` and
  `Attempted to kill init! exitcode=0x00002a00`, in that order.
- With the same command line on four vCPUs and no initramfs, the log must
  show the MP table at `0x9fc00`, `Processor #0` to `#3`, the IOAPIC with ID
  5 and GSI 0-23, `smp: Brought up 1 node, 4 CPUs`, and no unstable TSC.
- With the same command line on four vCPUs and an `/init` that pins itself
  to each CPU in turn with `sched_setaffinity` and sets bit i when `getcpu`
  then reports CPU i, the log must show `exitcode=0x00000f00`.
- With `console=ttyS0 panic=-1 reboot=k`, one vCPU and an `/init` that
  prints a line, waits for the tty to send it and restarts the machine, the
  log must show the 16550A on IRQ 4, `rtc_cmos rtc_cmos: setting system
  clock to 2026-01-02T03:04:05 UTC (1767323045)`, that line and
  `reboot: Restarting system`, in that order. GSI 4 must have been raised,
  no MMIO access may go unclaimed, and the only unclaimed port access must
  be one read: Linux's probe of port `0x87`.
- The same boot with a console sink that takes nothing until the run has
  ended, and a 4 KiB queue, must still end with `GuestReset`. The queue drops
  the oldest bytes and counts them; the sink then gets the batch the worker
  held when it stalled and the newest 4 KiB, with the restart line.
- The same boot with every interrupt dropped must log
  `Run /init as init process` but not the start of `/init`'s line, and end at
  a 3-second timeout. Against vm-superio 0.8.1 it fails: the first 16 bytes
  leave without IRQ 4.
- With the earlycon command line, one vCPU and an `/init` that calls `pause`
  forever, a `StopHandle::stop` sent once `Run /init as init process`
  appears must make `Vm::run` return `StopRequested` within two seconds.

The boot with every interrupt dropped and the stopped boot end in
`StopRequested`. Every other boot must end in `GuestReset`: `panic=-1
reboot=k` turns a panic, and the restart, into the i8042 reset.

## Lifecycle

`Vm::run` runs on x86_64, against any backend that implements
`boxlite_hypervisor::X86Vm`; unit tests drive it on the mock backend. Before
it registers any RAM, `Vm::with_backend` builds the `Chipset` from the
devices it is given, so a conflict fails with `ChipsetConflicts` and leaves
nothing mapped.

1. It starts one scoped thread per vCPU, named `vcpuN`. Each creates its vCPU,
   sets its CPUID from `vcpu_cpuid` and the boot MSRs, and on vCPU 0 the entry
   registers, then waits at a start gate until every vCPU is configured. A
   vCPU that fails setup sends `VcpuFailed` before it arrives, so the latch
   keeps every vCPU out of the guest, and a thread that fails to start aborts
   the gate, so no worker waits forever.
2. Each worker then loops: check the stop latch, run, and hand the exit to
   `Chipset::dispatch`. `Shutdown` sends `GuestShutdown` and `Reset` sends
   `GuestReset`; a run error, any other exit, such as `Halted`, which KVM never
   returns with its in-kernel irqchip, or a panic caught around the worker
   sends `VcpuFailed`. A worker that sees the latch completes the pending
   access and returns without sending.
3. `EventSender::send` sets the stop latch before it queues, so the vCPU
   that sends, such as the one whose `0xFE` reached the i8042, never enters
   the guest again. `run` takes the first event from the `EventLoop`, kicks
   every vCPU, and joins them all before it returns: `StopRequested`,
   `GuestShutdown` and `GuestReset` become `VmExit`, and `VcpuFailed` or
   `DeviceFailed` its error. Later events are dropped.

`Vm::stop_handle` returns a `StopHandle` that sends `StopRequested` from any
thread, even before `run` starts. A VM runs once: a second `run` fails with
`AlreadyRan`, since its latch stays set and its vCPUs already exist.

## Long-mode entry

On Linux x86_64, `boot::entry::long_mode_entry(ram, entry, boot_params)`
writes the state that the Linux 64-bit boot protocol requires
(`Documentation/arch/x86/boot.rst`, "64-bit Boot Protocol") and returns the
boot vCPU registers, which the vCPU 0 worker applies after its CPUID and
MSRs.

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

`cpu_features::vcpu_cpuid(supported, index, count)` turns KVM's supported
CPUID into vCPU `index`'s. KVM passes the host's APIC ID through and reports
no topology, so it sets:

- leaf 1: APIC ID `index`, `count` rounded up to a power of two, a 64-byte
  CLFLUSH line whatever the host reports, HTT when `count > 1`, and the
  hypervisor and TSC-deadline bits;
- leaf 0xB, and 0x1F when KVM lists it: an SMT level of one thread and a
  core level of `count` cores whose shift of 6 covers every APIC ID up to 64;
- on AMD and Hygon, 0x8000_001E (APIC and core ID `index`, node 0) and
  0x8000_0008 ECX (ApicIdSize 6, `count - 1` more cores).

Every other entry is kept, so vCPUs differ only in their APIC ID.
`BOOT_MSRS` adds FAST_STRING to KVM's MISC_ENABLE and enables MTRRs with a
write-back default; KVM already creates the other boot MSRs as zero. The
local APIC keeps its KVM reset state, with LINT0 in ExtINT mode on the boot
vCPU; Linux programs LINT1 itself.

## Buses, lines and events

These are the pieces the [legacy devices](#legacy-devices-and-the-console)
are built from. `Vm` owns the chipset they form, but `Vm::new` adds no
device yet.

- **Buses.** `bus::Bus` maps non-overlapping `BusRange`s, each named by its
  owner, to a `BusDevice` and the register offset the device sees at the
  range base, so the i8042 can claim port `0x60` as register 0 and port
  `0x64` as register 4. `insert` fails with the owner of the range a new one
  overlaps. A range without a device reserves a window the host serves in
  the kernel. The bus holds the devices' strong references and never changes
  once built, so lookups take no lock.
- **Dispatch.** `Buses::dispatch` serves `MmioRead`, `MmioWrite`, `IoIn` and
  `IoOut` and returns every other exit. An access must lie entirely inside one
  range. An access no device holds, or one that crosses a range end, reads
  `0xFF`, drops its write and is counted by `Bus::unclaimed`; Linux probes
  port `0x87` once at boot and takes `0xFF` as no ISA DMA controller. Reads
  reach a device zero-filled. A device whose lock an earlier panic poisoned
  stops the next access too.
- **Lines.** `irq::IrqLine` drives one line through `IrqChip::set_line`,
  which every host VM implements with `Vm::set_irq_line`; the distinct name
  keeps the two traits from colliding where both are in scope. It is not
  `Clone`. `pulse` raises an edge; `set_level` holds a level, makes no host
  call for a repeated level and keeps the old level when the host call fails,
  so the next call retries. Dropping a line held high lowers it and logs a
  failure to do so.
- **Events.** A device ends the VM by sending `Event::GuestReset` or
  `Event::DeviceFailed` through an `EventSender`, which never blocks or
  panics, latches the stop for every vCPU, and wakes the `EventLoop`'s `mio`
  poller. vCPU workers and `StopHandle` send the other events. An event sent
  after the loop is gone is logged at debug level and discarded. `EventLoop::wait` returns
  the oldest event, or `None` at its timeout, and rechecks the queue every
  second in case a wake-up was lost. Every event ends the VM; the VMM never
  restarts a guest.

## Chipset

`chipset::ChipsetBuilder` is the one registry of port ranges, MMIO ranges and
interrupt lines, like OpenVMM's chipset builder. Platform code reserves the
windows the host serves in the kernel, then adds each device by name with a
closure that claims the device's resources from a `Resources` handle and
returns the device. `build` reports every conflict at once, naming the
claimant and the owner, or returns an immutable `Chipset` that owns the
devices:

```text
5 chipset conflict(s): intruder claims port range 0x3fe+0x4, held by com1; intruder claims port range 0x42+0x1, held by in-kernel PIT; intruder claims MMIO range 0xfee00800+0x10, held by in-kernel local APIC; intruder claims MMIO range 0x1000+0x0, which is empty or wraps; intruder claims interrupt line 4, held by com1;
```

- **Claims.** A claim never fails: `Resources` records it, so the closure
  always finishes and every later claim is still checked. A rejected claim
  leaves the range or line with its first owner, so every later conflict
  names that owner. `pio_with_offset` sets the device offset a range's first
  port reaches, for a controller whose ports are split across several ranges.
- **Constructors.** A constructor only claims resources and builds state; a
  device that needs a thread starts it after `build`. A line from
  `Resources::line` is not armed until `build` succeeds: using it earlier
  fails with `Error::LineNotArmed` and makes no host call, so a device that a
  conflict discards never raised anything. On a conflict, every device drops
  without having run.
- **Dispatch.** `Chipset::dispatch` hands a vCPU exit to the buses and
  returns every exit that is not MMIO or port I/O. The chipset never changes
  after the build, so every vCPU thread shares it without a lock of its own.

## Legacy devices and the console

On x86_64, `devices::x86_64::add_legacy_devices` reserves the in-kernel PIC
(`0x20`, `0xA0`, `0x4D0`), PIT (`0x40`–`0x43`, `0x61`), IOAPIC and local APIC
windows, then adds the legacy devices:

| Ports | Device | Behavior |
| --- | --- | --- |
| `0x3F8`–`0x3FF` | `com1`, vm-superio's 16550A | Output goes to the console queue; a pending, enabled THRE or RDA raises an edge on GSI 4; no input yet |
| `0x70`–`0x71` | `cmos` | See [CMOS RTC](#cmos-rtc) |
| `0x60`, `0x64` | `i8042`, vm-superio's controller | Reads 0; the first `0xFE` at `0x64` sends `GuestReset` |

- vm-superio must be 0.8.2 or later. It raises THRE on every IER write, so
  Linux's 8250 driver passes its THRE and TXEN probes and sends tty output on
  IRQ 4. Against 0.8.1 the driver enables `UART_BUG_TXEN` and sends 16 bytes
  without the interrupt.
- The serial port writes into `devices::console::ConsoleWriter`, a bounded
  queue of 64 KiB, and returns at once; a `console` thread writes the queue to
  the sink. A full queue drops its oldest bytes, as the kernel's own log ring
  does, and counts them, so a stalled or failing sink never stalls the guest.
  A batch the sink refuses and a write after `finish` count as dropped too;
  a queue of 0 bytes is refused.
- `ConsoleWorker::finish` closes the queue and waits up to 1 s for the worker
  to write the rest. A sink write cannot be cancelled, so after that it leaves
  the worker behind and counts every byte the sink never took, the batch the
  worker holds included, as dropped.
- A failed interrupt sends `DeviceFailed`, once.
- The guest kernel has no i8042 driver, so the reset is all the device does.

## CMOS RTC

On x86_64, `devices::cmos::CmosRtc` is the PC's real-time clock. The guest
writes a register number to port `0x70`, then reads or writes that register
at `0x71`. Linux reads the date and time from it once at boot to set its
system clock.

- The time is an injected `Clock` plus an offset that keeps any time the
  guest sets. `cmos::host_clock` reads the host wall clock; the tests inject
  a fixed time.
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
`long_mode_entry`, with `vcpu_cpuid` and `BOOT_MSRS` applied, reloads its
segments from the GDT in RAM, reads markers at RSI and at the top of RAM, and
stores RFLAGS, CR0, CR3, CR4, EFER, CPUID leaves 1 and 0xB, MISC_ENABLE and
MTRRdefType for the test to compare. The 3 GiB allocation is `MAP_NORESERVE`, so only the touched
pages are committed; a host with `vm.overcommit_memory=2` refuses it. The
[bus](#buses-lines-and-events) and [chipset](#chipset) tests in `tests::kvm`
modules need 2 MiB: a flat 32-bit guest writes and reads a test device on the
port bus at its register offset, and an `IrqLine` sets GSI 4 and 5 through
`KVM_IRQ_LINE`, skipping a repeated level. Another flat guest reads a claimed
and an unclaimed port of a built chipset, and the device's line, armed by the
build, reaches KVM. A third runs on the [legacy devices](#legacy-devices-and-the-console):
it prints `OK` on COM1, reads the CMOS seconds from a fixed clock, reads an
unclaimed port and unmapped MMIO as all ones, and runs no instruction after
its i8042 reset. CI runs the same tests through
`make coverage:vmm:kvm`.

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
