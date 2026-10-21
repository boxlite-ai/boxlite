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
├── vm-memory
└── linux-loader (Linux x86_64 ELF loading and boot parameters)
```

| Module | Planned responsibility |
| --- | --- |
| `vm` | `Vm<H>`: validate the configuration, then allocate and register RAM on host backend `H`; `run` is a placeholder |
| `boot` | Linux x86_64 boot: `prepare` loads the pinned ELF kernel through linux-loader, places an optional initramfs at the top of RAM, writes the zero page, E820 map, command line and MP table, and sets up the 64-bit entry state (GDT, identity page tables, registers) |
| `config` | `VmConfig { vcpu_count, memory_mib, kernel, cmdline, initramfs }` and its bounds: 1..=64 vCPUs, 1..=3072 MiB, a printable-ASCII command line under 2048 bytes |
| `error` | VMM errors that keep the hypervisor's cause chain |
| `memory` | `GuestRam`: owned guest RAM, the RAM layout, and the registration lifetime rules |
| `cpu_features` | x86_64 guest CPUID for each vCPU and the boot MSRs |
| `vcpu` | Worker threads, stop coordination, and exit handling |
| `irq` | Device interrupt assignment and routing; HVF and KVM provide the controller, WHP (M10) only local APICs |
| `bus` | Address-range registration and device I/O dispatch |

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
segment loading to rust-vmm's linux-loader and returns the entry address as
`io::Result<u64>`. It reads `kernel` through a seekable reader, usually the
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
`load_initramfs` when `config.initramfs` is set, then `write_boot_params`,
`write_mptable` and `long_mode_entry`, in that order on fresh RAM, and returns
a `BootSetup` with the boot vCPU registers. A failure names its step,
`LoadKernel`, `LoadInitramfs` or `WriteBootData`, and keeps the I/O cause.
Nothing calls `prepare` from `Vm` yet.

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

Each runs `prepare` for 256 MiB of RAM and the command line
`earlycon=uart8250,io,0x3f8 keep_bootcon panic=-1 reboot=k`, then runs each
KVM vCPU on its own thread with its guest CPUID and the boot MSRs. Every vCPU
is created before any runs, and only vCPU 0 gets the entry registers. A
test-local stub stands in for the devices: it keeps the earlycon bytes written
to `0x3f8`, reports the UART as idle on `0x3fd`, reads every other port and
MMIO address as zero, and ignores other writes. Each run ends when a vCPU
writes `0xFE` to the i8042 port `0x64`, the reset `reboot=k` asks for after a
panic, and every vCPU is then kicked; an unexpected exit or a watchdog after 30
seconds also ends it, so a failed boot reports the log so far.

- On one vCPU without an initramfs, the log must show the kernel version, the exact
  command line, the two E820 entries, the memory total and
  `VFS: Unable to mount root fs`.
- On one vCPU with a generated archive whose `/init`, a 132-byte static ELF, calls
  `exit_group(42)`, the log must show the `RAMDISK:` range from the zero page,
  `Unpacking initramfs...`, `Run /init as init process` and
  `Attempted to kill init! exitcode=0x00002a00`, in that order.
- On four vCPUs without an initramfs, the log must show the MP table at
  `0x9fc00`, `Processor #0` to `#3`, the IOAPIC with ID 5 and GSI 0-23,
  `smp: Brought up 1 node, 4 CPUs`, and no unstable TSC.
- On four vCPUs with an `/init` that pins itself to each CPU in turn with
  `sched_setaffinity` and sets bit i when `getcpu` then reports CPU i, the log
  must show `exitcode=0x00000f00`.

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
