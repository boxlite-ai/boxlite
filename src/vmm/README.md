## TL;DR

BoxLite's native VMM can prepare x86_64 ELF kernel memory; its VM lifecycle and Linux boot path are still placeholders.

## Current implementation

The crate-visible VM and vCPU `run`
entry points sketch event dispatch, guest exits, and worker cleanup with inline
`todo!()` operations that panic if called. VM event labels stay local to
`Vm::run`; vCPU exits use `boxlite_hypervisor::VcpuExit`, and `Error` wraps
`boxlite_hypervisor::Error` with its cause chain intact. The VM facade cannot
create or boot a VM yet. The [VMM design](../../docs/contributing/architecture/vmm/README.md)
specifies the lifecycle API, memory layout, buses, interrupts, and threads it
will implement.

The lifecycle types and `Error` remain crate-visible while those entry points
are placeholders. M1 will make the implemented `Vm`, `VmExit`, `Error` and
`Result` public together; M2's engine adapter will then consume that API and
inspect the error's host cause.

```text
boxlite-vmm
├── boxlite-hypervisor
├── linux-loader (Linux x86_64)
└── vm-memory (Linux x86_64)
```

| Module | Responsibility and status |
| --- | --- |
| `vm` | VM facade and lifecycle coordination |
| `config` | Machine configuration and boundary validation |
| `error` | VMM errors that keep the hypervisor's cause chain |
| `memory` | Implemented: owned contiguous RAM and checked x86_64 ELF loading; general guest address layout remains planned |
| `vcpu` | Worker threads, stop coordination, and exit handling |
| `irq` | Device interrupt assignment and routing; HVF and KVM provide the controller, WHP (M10) only local APICs |
| `bus` | Address-range registration and device I/O dispatch |

The KVM x86_64 backend already supports VM/vCPU creation, memory registration,
registers, execution, and kicks. Connecting those operations into a Linux boot
path follows in M1. Virtio devices, the BoxLite
engine adapter, engine selection, and `native` feature wiring follow in M2.
Neither new crate depends on `boxlite-shared`, and both are unpublished while
their interfaces are being established.

## Kernel loading

On Linux x86_64, `memory::KernelMemory::load(image, ram_mib)` validates an immutable
ELF image and prepares fresh RAM. This internal API remains separate from the
placeholder lifecycle API. See the [loading design](../../docs/contributing/investigations/vmm-elf-loading.md).

- Input: little-endian x86_64 ELF64 executable (`vmlinux`), not `bzImage`.
- RAM: 1–3072 MiB at GPA zero; segments must fit at or above 1 MiB.
- Placement: file bytes go to `PT_LOAD.p_paddr`; BSS and gaps remain zero.
- Rejections: truncated headers/payloads, dynamic linking, overflow, overlapping
  segments, invalid alignment, and entries outside file-backed executable bytes.
- Ownership: keep RAM alive until the VM, all vCPUs, and every host user are done.

The explicit hardware test needs Linux x86_64, readable/writable `/dev/kvm`,
`readelf`, and an already-built `vmlinux` that fits in 128 MiB:

```sh
make test:integration:vmm:kernel VMM_KERNEL=/absolute/path/to/vmlinux
```

`VMM_KERNEL` defaults to `target/vmm/boot/x86_64/vmlinux`. The test uses `readelf`
to check loaded bytes and BSS, then runs a small KVM guest that reads the entire
loaded kernel span and returns a checksum. Missing prerequisites fail explicitly;
guest execution has a 60-second process timeout.

This proves loading and guest access, not Linux execution. Boot parameters,
initramfs placement, Linux entry state, devices, and the run loop remain to be
connected before expecting `/init` or `BOXLITE_M1_OK`.

## Build

`make vmm:boot` builds the x86_64 kernel and minimal test initramfs using Linux
host tools. See [boot artifacts](boot/README.md) for dependencies, output files
and reproducibility limits. This prepares artifacts; it does not boot a VM.

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
