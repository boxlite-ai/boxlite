# boxlite-vmm

Workspace skeleton for BoxLite's native VMM. The crate-visible VM and vCPU `run`
entry points sketch event dispatch, guest exits, and worker cleanup with inline
`todo!()` operations that panic if called. VM event labels stay local to
`Vm::run`; vCPU exits use `boxlite_hypervisor::VcpuExit`, and `Error` wraps
`boxlite_hypervisor::Error` with its cause chain intact. This crate cannot
create or boot a VM yet. The [VMM design](../../docs/architecture/vmm/README.md)
specifies the lifecycle API, memory layout, buses, interrupts, and threads it
will implement.

The lifecycle types and `Error` remain crate-visible while those entry points
are placeholders. M1 will make the implemented `Vm`, `VmExit`, `Error` and
`Result` public together; M2's engine adapter will then consume that API and
inspect the error's host cause.

```text
boxlite-vmm
└── boxlite-hypervisor
```

| Module | Planned responsibility |
| --- | --- |
| `vm` | VM facade and lifecycle coordination |
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
