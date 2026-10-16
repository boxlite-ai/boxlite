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
└── linux-loader (Linux x86_64 ELF loading)
```

| Module | Planned responsibility |
| --- | --- |
| `vm` | `Vm<H>`: validate the configuration, then allocate and register RAM on host backend `H`; `run` is a placeholder |
| `boot` | Linux x86_64 boot: load the pinned ELF kernel through linux-loader and prepare the 64-bit entry state (GDT, identity page tables, registers); boot data and lifecycle wiring follow |
| `config` | `VmConfig { vcpu_count, memory_mib }` and its bounds: 1..=64 vCPUs, 1..=3072 MiB |
| `error` | VMM errors that keep the hypervisor's cause chain |
| `memory` | `GuestRam`: owned guest RAM, the RAM layout, and the registration lifetime rules |
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
boot data and Linux execution belong to later slices.

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
`long_mode_entry` reloads its segments from the GDT in RAM, reads markers at
RSI and at the top of RAM, and stores RFLAGS, CR0, CR3, CR4 and EFER for the
test to compare. The 3 GiB allocation is `MAP_NORESERVE`, so only the touched
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
