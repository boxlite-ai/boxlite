# boxlite-vmm

Workspace skeleton for BoxLite's native VMM. It validates its machine
configuration and allocates guest RAM; the crate-visible VM and vCPU `run`
entry points still sketch event dispatch, guest exits, and worker cleanup with
inline `todo!()` operations that panic if called. VM event labels stay local to
`Vm::run`; vCPU exits use `boxlite_hypervisor::VcpuExit`, and `Error` wraps
`boxlite_hypervisor::Error` with its cause chain intact. This crate cannot
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
└── vm-memory
```

| Module | Planned responsibility |
| --- | --- |
| `vm` | VM facade and lifecycle coordination |
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

Unit tests drive these paths with a recording fake backend. The test files
live under `tests/` and are included as unit-test modules, which keeps them
outside the counted sources and the coverage denominator. `Vm::new`, which
composes validate, allocate, create the host VM and map, is the next slice.

## Build

From the repository root:

```sh
make vmm
make clippy:vmm
make test:unit:vmm
make fmt:check:rust
```

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
