# boxlite-vmm

Workspace skeleton for BoxLite's native VMM. The crate-visible VM and vCPU `run`
entry points sketch event dispatch, guest exits, and worker cleanup with inline
`todo!()` operations that panic if called. VM event labels stay local to
`Vm::run`; vCPU exits use `boxlite_hypervisor::VcpuExit`, and `Error` wraps
`boxlite_hypervisor::Error` with its cause chain intact. This crate places an
x86_64 ELF `vmlinux` in guest RAM but cannot create or boot a VM yet. The [VMM design](../../docs/contributing/architecture/vmm/README.md)
specifies the lifecycle API, memory layout, buses, interrupts, and threads it
will implement.

The lifecycle types and `Error` remain crate-visible while those entry points
are placeholders. M1 will make the implemented `Vm`, `VmExit`, `Error` and
`Result` public together; M2's engine adapter will then consume that API and
inspect the error's host cause.

```text
boxlite-vmm
├── boxlite-hypervisor
└── vm-memory (guest-memory access)
```

| Module | Planned responsibility |
| --- | --- |
| `vm` | VM facade and lifecycle coordination |
| `boot` | Implemented for x86_64: validated ELF `vmlinux` placement; `boot_params`, command line, MP table and entry registers follow |
| `config` | Machine configuration and boundary validation |
| `error` | VMM errors that keep the hypervisor's cause chain |
| `memory` | Backing-memory ownership and guest address layout |
| `vcpu` | Worker threads, stop coordination, and exit handling |
| `irq` | Device interrupt assignment and routing; HVF and KVM provide the controller, WHP (M10) only local APICs |
| `bus` | Address-range registration and device I/O dispatch |

Backend implementation and guest boot follow in M1. Virtio devices, the BoxLite
engine adapter, engine selection, and `native` feature wiring follow in M2.
Neither new crate depends on `boxlite-shared`, and both are unpublished while
their interfaces are being established.

## Kernel loading

On Linux x86_64, `boot::elf::load_elf(ram, image)` validates an ELF `vmlinux`
and copies its `PT_LOAD` segments into borrowed guest memory (any vm-memory
`GuestMemoryBackend`). It returns the entry, the lowest segment start and the
highest segment end. It stays crate-visible until the lifecycle slice calls it
from `Vm::new`.

- Input: little-endian x86_64 ELF64 executable (`vmlinux`), not `bzImage`.
- Placement: file bytes at `p_paddr`; BSS zero-filled; bytes between segments
  untouched; nothing is written if any check fails.
- Rejected: truncated headers or payloads, dynamic linking, address overflow,
  segments below 1 MiB or outside registered RAM, overlapping segments (BSS
  included), and an entry outside file-backed executable bytes.
- Dependencies: vm-memory only. linux-loader's ELF loader cannot zero BSS on
  borrowed RAM and adds no check the preflight lacks.

The hardware probe needs Linux x86_64, read/write `/dev/kvm`, binutils
`readelf`, and an x86_64 `vmlinux` whose segments end below 128 MiB:

```sh
make test:integration:vmm:elf VMM_KERNEL=/absolute/path/to/vmlinux
```

`VMM_KERNEL` defaults to `target/vmm/boot/x86_64/vmlinux`, where the kernel
build slice publishes its artifact. The probe compares every segment with
`readelf`, then a protected-mode guest sums the loaded span and reports it on
an I/O port. A missing kernel or `/dev/kvm` fails rather than skips. It proves
loading and guest visibility, not Linux execution: `boot_params`, initramfs,
entry registers and the run loop are later slices.

## Build

From the repository root:

```sh
make vmm
make clippy:vmm
make test:unit:vmm
make fmt:check:rust
```

With the corresponding Rust targets installed, the library skeleton can also
be compiled for each host with a backend module without booting a VM:

```sh
CARGO_BUILD_TARGET=aarch64-apple-darwin make vmm
CARGO_BUILD_TARGET=x86_64-unknown-linux-gnu make vmm
CARGO_BUILD_TARGET=aarch64-unknown-linux-gnu make vmm
CARGO_BUILD_TARGET=x86_64-pc-windows-msvc make vmm
```

The existing Clippy CI matrix compiles workspace crates on the first three
hosts. No CI job compiles the Windows target, whose `whp` module is reserved
for M10.
