# boxlite-vmm

Workspace skeleton for BoxLite's native VMM. The crate-visible VM and vCPU `run`
entry points sketch event dispatch, guest exits, and worker cleanup with inline
`todo!()` operations that panic if called. VM event labels stay local to the VM
loop; vCPU exits use `boxlite_hypervisor::VcpuExit`. This crate cannot create or
boot a VM yet.

```text
boxlite-vmm
└── boxlite-hypervisor
```

| Module | Planned responsibility |
| --- | --- |
| `vm` | VM facade and lifecycle coordination |
| `config` | Machine configuration and boundary validation |
| `error` | VMM errors |
| `memory` | Backing-memory ownership and guest address layout |
| `vcpu` | Worker threads, stop coordination, and exit handling |
| `irq` | Device interrupt assignment, routing, and controller emulation |
| `bus` | Address-range registration and device I/O dispatch |

Backend implementation and guest boot follow in M1; virtio devices follow in M2.
The BoxLite engine adapter, engine selection, and `native` feature wiring are
separate work. Neither new crate depends on `boxlite-shared`, and both are
unpublished while their interfaces are being established.

## Build

From the repository root:

```sh
make vmm
make clippy:vmm
make fmt:check:rust
```

With the corresponding Rust targets installed, the library skeleton can also
be compiled for each supported host without booting a VM:

```sh
CARGO_BUILD_TARGET=aarch64-apple-darwin make vmm
CARGO_BUILD_TARGET=x86_64-unknown-linux-gnu make vmm
CARGO_BUILD_TARGET=aarch64-unknown-linux-gnu make vmm
```

The existing Clippy CI matrix compiles workspace crates on all three hosts.
