# boxlite-hypervisor

Host backends for BoxLite's VMM: HVF on macOS arm64 and KVM on Linux x86_64
and arm64, with WHP on Windows x86_64 reserved for M10. The `Vm`, `Vcpu` and
`VcpuHandle` traits, with `VcpuExit`, `MemoryRegion` and `Error`, are the
current shared contract; M1 adds the vCPU register access and HVF `CPU_ON`
exit that boot needs, and the HVF and KVM backends themselves. The rules each
backend keeps are in the
[VMM design](../../docs/contributing/architecture/vmm/README.md#hypervisor-backend-interface).

This crate owns host VM/vCPU handles, memory registration, interrupt
injection, and decoding host exits. It is a leaf among the BoxLite crates;
machine layout and device emulation belong to `boxlite-vmm`.

| Module | Responsibility |
| --- | --- |
| `vm` | `Vm`: memory mapping, vCPU creation, and interrupt lines |
| `vcpu` | `Vcpu` and `VcpuHandle`: running a vCPU, completing pending I/O before stop, and kicking it from another thread |
| `exit` | `VcpuExit`: decoded exits and the I/O completion contract |
| `memory` | `MemoryRegion`: host memory mapped into the guest |
| `error` | `Error`: the failed operation, its resource, and the host cause |
| `hvf` / `hvf::syndrome` | HVF operations and ARM exception decoding (not implemented yet) |
| `kvm` / `kvm::memory` | KVM operations and private memory-slot allocation (not implemented yet) |
| `whp` / `whp::emulator` | WHP operations and x86 instruction decoding for memory-access exits (reserved for M10) |

Three boundaries decide placement when a case is ambiguous: KVM memory-slot
indices stay inside `kvm`, because HVF has no such concept; ARM syndrome
decoding stays inside `hvf`, so `boxlite-vmm` never sees a raw `ESR_EL2`; and
x86 instruction decoding stays inside `whp`, so `boxlite-vmm` never sees raw
instruction bytes.

The backend modules are selected by host OS and architecture, and a host with
no backend fails the build rather than producing a library that exposes no VM
operations. The traits are exported from the crate root; each backend's
concrete type, `HvfVm`, `KvmVm` or `WhpVm`, will get its own export path.

From the repository root, run `make vmm`, `make clippy:vmm` or
`make test:unit:vmm`. See the [VMM README](../vmm/README.md) for cross-target
build commands.
