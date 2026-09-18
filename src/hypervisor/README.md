# boxlite-hypervisor

Workspace skeleton for the HVF (macOS arm64) and KVM (Linux x86_64/arm64)
backends. No hypervisor operations or public API are implemented yet.

This crate will own host VM/vCPU handles, memory registration, interrupt
injection, and decoding host exits. It is a leaf among the BoxLite crates;
machine layout and device emulation belong to `boxlite-vmm`.

| Module | Planned responsibility |
| --- | --- |
| `vm` | VM backend conformance contract |
| `vcpu` | vCPU contract and separate transferable kick handle |
| `exit` | Decoded exits and I/O completion contract |
| `memory` | Guest-region registration and backing-memory lifetime contract |
| `error` | Hypervisor errors |
| `hvf` / `hvf::syndrome` | HVF operations and ARM exception decoding |
| `kvm` / `kvm::memory` | KVM operations and private memory-slot allocation |

The backend modules are selected by host OS and architecture. Concrete backend
types and conformance traits will get distinct export paths when implemented.

From the repository root, run `make vmm` or `make clippy:vmm`. See the
[VMM README](../vmm/README.md) for cross-target build commands.
