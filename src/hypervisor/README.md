# boxlite-hypervisor

Host backends for BoxLite's VMM: HVF on macOS arm64 and KVM on Linux x86_64
and arm64, with WHP on Windows x86_64 reserved for M10. The `Vm`, `Vcpu` and
`VcpuHandle` traits, with `VcpuExit`, `MemoryRegion` and `Error`, are the
shared contract. Each architecture extends it with the register access boot
needs: `X86Vm` and `X86Vcpu` on x86_64, `Arm64Vcpu` on arm64, where
`VcpuExit::CpuOn` also carries the PSCI `CPU_ON` that HVF leaves to the VMM.
The rules each backend keeps are in the
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
| `arm64` | `Arm64Vcpu`, `Arm64BootRegisters` and `CpuOnResult`: the arm64 boot registers and the VMM's answer to `CPU_ON` |
| `hvf` | macOS arm64: the VM and its in-kernel GICv3, memory, vCPU execution and kicks, with `syndrome` decoding exceptions and emulating trapped system registers, and `psci` serving PSCI 0.2 |
| `kvm` | x86_64 VM creation, memory slots, registers, CPUID/MSRs, execution, kicks and pending-I/O completion; arm64 follows |
| `whp` / `whp::emulator` | WHP operations and x86 instruction decoding for memory-access exits (reserved for M10) |

Three boundaries decide placement when a case is ambiguous: KVM memory-slot
indices stay inside `kvm`, because HVF has no such concept; ARM syndrome
decoding stays inside `hvf`, so `boxlite-vmm` never sees a raw `ESR_EL2`; and
x86 instruction decoding stays inside `whp`, so `boxlite-vmm` never sees raw
instruction bytes.

## Backend status

The backend modules are selected by host OS and architecture, and a host with
no backend fails the build rather than producing a library that exposes no VM
operations. The traits are exported from the crate root. Linux x86_64 also
exports `KvmVm` and thread-bound `KvmVcpu`, with creation, memory registration,
`run` and `complete_pending_io`. `KvmVm` and `KvmVcpu` implement the shared `Vm`
and `Vcpu` traits, including IRQ forwarding and cross-thread kick handles.
`run` blocks on an idle guest until interrupted.

`KvmVcpu::set_boot_registers` installs `X86BootRegisters`: general entry registers,
segments, descriptor tables, control registers, and the x87 control word (`FCW` is
`0x037f`). A fresh vCPU's reset SSE state has `MXCSR` `0x1f80`. Hardware tests
read MXCSR from the legacy SSE area returned by `KVM_GET_XSAVE`;
`KVM_GET_FPU` does not return it.
Values and guest addresses come from the VMM; no Linux memory layout lives in
KVM.
Call it before first entry and discard the vCPU after any configuration error,
because multiple host writes cannot be rolled back atomically. Secondary vCPUs
retain reset state until INIT/SIPI.

`KvmVm::supported_cpuid` exposes host-supported CPU features. A VMM can remove
features or adjust topology, then pass the result to `KvmVcpu::set_cpu_features`
before entry. `X86CpuidEntry` preserves subleaf matching without leaking the
KVM ABI. Legacy stateful CPUID entries are omitted because this type cannot
preserve their read sequence; other unsupported KVM flags are rejected.
MSRs are explicit index/value writes. A short KVM write is an error identifying
the first rejected MSR, never a successful partially configured CPU. Host feature
discovery is a ceiling, not permission to add unsupported instructions.

These three methods form the x86_64 extension traits `X86Vm`
(`supported_cpuid`) and `X86Vcpu` (`set_cpu_features`, `set_boot_registers`),
which `KvmVm` and `KvmVcpu` implement, so the VMM's vCPU workers and its mock
backend use one interface. On arm64, `Arm64Vcpu` sets MPIDR_EL1 (`set_mpidr`) and
the entry PC, X0 and PSTATE (`set_boot_registers`).

macOS arm64 exports `HvfVm` and thread-bound `HvfVcpu`, which implement `Vm`,
`Vcpu` and `Arm64Vcpu` on Hypervisor.framework with the in-kernel GICv3 of
macOS 15. Design and research: [#2103](https://github.com/boxlite-ai/boxlite/issues/2103).

- **One VM per process.** `HvfVm::new` creates the VM, then the GIC at the
  distributor and redistributor bases the VMM picks, after checking them
  against the alignment and region sizes HVF reports. A second VM fails with
  `ResourceBusy`; a missing hypervisor entitlement with `PermissionDenied`;
  macOS 12 to 14, which lack the in-kernel GIC, with `Unsupported`, a path no
  tested host exercises. The GIC calls are looked up at run time, so a binary
  that links the backend imports none of them; a unit test checks its own
  binary with `nm -u`.
- **Exits.** `run` decodes the exception syndrome itself:
  - data aborts with a valid syndrome become `MmioRead` and `MmioWrite`. The
    next `run` or `complete_pending_io` writes a read's value, sign- or
    zero-extended by the syndrome, and moves PC past the access. PC advancement
    wraps at 64 bits: an instruction at `0xffff_ffff_ffff_fffc` completes at
    PC zero even with overflow checks enabled. Register 31 is XZR, never HVF's
    PC. A cache-maintenance abort is skipped, as in QEMU;
  - HVC is PSCI 0.2. The backend answers `VERSION` and `MIGRATE_INFO_TYPE`
    itself, and any other call it does not act on with `NOT_SUPPORTED`, without
    an exit. `SYSTEM_OFF` and `SYSTEM_RESET` end the VM, and `CPU_ON` becomes
    `VcpuExit::CpuOn`, whose `result` the guest reads back;
  - trapped system registers are emulated as QEMU does: the OS lock that
    Linux clears at boot, the other debug registers and the reserved ID space
    as zero;
  - SMC, a data abort without a usable syndrome or from a stage-1 table walk,
    and any other exception are `UnhandledExit`, with the guest PC.
- **Waiting and kicks.** HVF waits out WFI itself and wakes the vCPU for its
  timer and for SPIs set from any thread, so no host thread parks.
  `HvfVcpuHandle::kick` calls `hv_vcpus_exit`, which HVF holds until the next
  `run`. Dropping the vCPU clears the ID a handle kicks before HVF can reuse it.

`KvmVcpu::handle()` can kick a worker before or during guest entry. Cloned handles
become inert when the vCPU is dropped or its worker exits, even if safe code
forgets the vCPU. `KvmVm::new()` reserves `SIGRTMIN + 1` on each worker, or the
application can select a realtime signal with `with_kick_signal`. Keep that signal unblocked
and at its default disposition before vCPU creation; do not reuse it while the
vCPU lives. No process-wide handler is installed. KVM temporarily unmasks the
signal during entry, and vCPU drop drains pending kicks before restoring its bit.
Signal validation and reservation run before KVM allocates a vCPU ID, so a caller
can fix a worker-mask error and retry with the same ID. KVM signal-mask setup is
applied after the vCPU fd is created.
Hardware qualification covers kicks queued before entry and kicks sent after
guest code publishes an atomic marker, plus inert handles after vCPU destruction.

`make test:unit:vmm` checks memory-slot validation and rollback without KVM.
On Linux x86_64, `make test:integration:vmm:kvm` requires read/write access to
`/dev/kvm`. It checks VM/interrupt-controller creation, executes instructions
from registered RAM, and replaces an unmapped region. Execution currently uses
the public facade; hardware tests also read back the public register configuration
through KVM to verify long-mode segments, entry addresses, and floating-point state.
Linux x64 CI runs these tests with `make coverage:vmm:kvm`, adding their coverage
to the unit profiles before upload; missing KVM access is a failure.

On macOS arm64, `make test:integration:vmm:hvf` runs the HVF hardware tests:
tiny machine-code guests that check MMIO widths and extension, PSCI, the OS
lock, MPIDR, WFI woken by an SPI from another thread, and kicks. Its runner
signs the test binary with `com.apple.security.hypervisor`, which
Hypervisor.framework requires, and the tests run one at a time because a
process holds one VM. Hosted macOS runners cannot nest virtualization, so these
tests run on a developer Mac.

M1 proceeds in boot order: create the VM and map RAM, create/run vCPUs, load
the kernel and boot metadata, attach legacy devices, then reach a test `/init`
and return the guest's reset to the caller. Linux x86_64 boots that way; for
macOS arm64 the backend is in place and the arm64 machine and first boot
follow ([#2103](https://github.com/boxlite-ai/boxlite/issues/2103)). Linux
arm64 comes later.

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
