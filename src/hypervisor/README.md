# boxlite-hypervisor

Workspace skeleton for the HVF (macOS arm64) and KVM (Linux x86_64/arm64)
backends. The shared `VcpuExit` type defines the exit and MMIO completion
contract; no hypervisor operations are implemented yet.

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

Two boundaries decide placement when a case is ambiguous: KVM memory-slot
indices stay inside `kvm`, because HVF has no such concept, and ARM syndrome
decoding stays inside `hvf`, so `boxlite-vmm` never sees a raw `ESR_EL2`.

The backend modules are selected by host OS and architecture, and a host with
neither backend fails the build rather than producing a library that exposes no
VM operations. Concrete backend types and conformance traits will get distinct
export paths when implemented.

From the repository root, run `make vmm` or `make clippy:vmm`. See the
[VMM README](../vmm/README.md) for cross-target build commands.
