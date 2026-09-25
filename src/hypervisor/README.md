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
| `kvm` | x86_64 VM creation, memory slots, vCPU execution and pending-I/O completion; boot registers, kicks and arm64 follow |
| `whp` / `whp::emulator` | WHP operations and x86 instruction decoding for memory-access exits (reserved for M10) |

Three boundaries decide placement when a case is ambiguous: KVM memory-slot
indices stay inside `kvm`, because HVF has no such concept; ARM syndrome
decoding stays inside `hvf`, so `boxlite-vmm` never sees a raw `ESR_EL2`; and
x86 instruction decoding stays inside `whp`, so `boxlite-vmm` never sees raw
instruction bytes.

The backend modules are selected by host OS and architecture, and a host with
no backend fails the build rather than producing a library that exposes no VM
operations. The traits are exported from the crate root. Linux x86_64 also
exports `KvmVm` and thread-bound `KvmVcpu`, with creation, memory registration,
`run` and `complete_pending_io`. Shared trait implementations await the kick
handle; `run` can block on an idle guest. Boot registers are not exposed yet.

`make test:unit:vmm` checks memory-slot validation and rollback without KVM.
On Linux x86_64, `make test:integration:vmm:kvm` requires read/write access to
`/dev/kvm`. It checks VM/interrupt-controller creation, executes instructions
from registered RAM, and replaces an unmapped region. Execution currently uses
the public facade; register setup still uses the private descriptor in the test.
Linux x64 CI runs these tests with `make coverage:vmm:kvm`, adding their coverage
to the unit profiles before upload; missing KVM access is a failure.

M1 proceeds in boot order: create the VM and map RAM, create/run vCPUs, load
the kernel and boot metadata, attach legacy devices, then reach a test `/init`
and return the guest's reset to the caller. The full M1 still includes Linux
arm64 and macOS arm64 after the initial Linux x86_64 path.

References for this step:

- [kvm-ioctls `src/lib.rs:39–56`](https://github.com/rust-vmm/kvm/blob/b4c9ed8df95a9e10a68f50f5ef5e7d04108759ba/kvm-ioctls/src/lib.rs#L39-L56)
  demonstrates VM creation, memory registration and a tiny machine-code guest.
- [Firecracker `arch/x86_64/vm.rs:170–183`](https://github.com/firecracker-microvm/firecracker/blob/68698adfee9b252df130b7a98e3ba04eb81f0f54/src/vmm/src/arch/x86_64/vm.rs#L170-L183)
  creates the in-kernel irqchip and PIT before any vCPU.
- [libkrun `linux/vstate.rs:446–476`](https://github.com/libkrun/libkrun/blob/e12b9b3780ffa8df9f3e1797b217d13453479167/src/vmm/src/linux/vstate.rs#L446-L476)
  checks the KVM API version and capabilities before constructing a VM.

From the repository root, run `make vmm`, `make clippy:vmm` or
`make test:unit:vmm`. See the [VMM README](../vmm/README.md) for cross-target
build commands.
