## TL;DR

Add the Linux x86_64 vCPU execution boundary needed for M1 first boot.

## Outcome

Follow #1576 and the [M1 roadmap](https://github.com/boxlite-ai/boxlite/milestone/2): own vCPU descriptors, return device exits, complete pending I/O, and support a reliable stop path. Close this issue only after all slices land and hardware qualification passes. Kernel loading and legacy devices remain separate M1 work.

Tracking issue: [#1698](https://github.com/boxlite-ai/boxlite/issues/1698).

## Related work and lessons

- [BoxLite's backend contract](https://github.com/boxlite-ai/boxlite/blob/a35976c08/src/hypervisor/src/vcpu.rs#L6-L44) requires thread-bound vCPUs, borrowed device buffers and completion before stopping. The [existing hardware test](https://github.com/boxlite-ai/boxlite/blob/a35976c08/src/hypervisor/src/kvm/vm.rs#L202-L245) currently bypasses that boundary through the raw descriptor. Adapt it to exercise the new facade.
- [rust-vmm vCPU implementation](https://github.com/rust-vmm/kvm/blob/b4c9ed8df95a9e10a68f50f5ef5e7d04108759ba/kvm-ioctls/src/ioctls/vcpu.rs) owns the descriptor/mapping and borrows I/O bytes. Reuse descriptor creation and KVM_RUN; preserve port count validation, which its decoded IoIn/IoOut variants do not expose.
- [Firecracker vCPU creation and boot setup](https://github.com/firecracker-microvm/firecracker/blob/68698adfee9b252df130b7a98e3ba04eb81f0f54/src/vmm/src/arch/x86_64/vcpu.rs#L114-L301) separates creation from boot configuration. Adopt that separation; device dispatch stays in boxlite-vmm instead of the hypervisor backend.
- [Linux KVM API, section 5](https://docs.kernel.org/virt/kvm/api.html#the-kvm-run-structure) specifies I/O completion on re-entry and immediate_exit completion without executing further instructions. Adopt this exact ordering. KVM_EXIT_SHUTDOWN on x86 means triple fault and maps to Reset, not successful guest poweroff.

## Design

A KvmVcpu facade owns its descriptor, ID and pending-I/O state. A thread marker prevents Send and Sync. KvmVm creates it after the in-kernel controllers already exist. Raw KVM storage and exit reasons remain private; callers see the existing VcpuExit and contextual Error types.

The first slice exposes inherent create_vcpu, run and complete_pending_io methods. The shared Vm/Vcpu traits are implemented only when the real kick handle exists; no dummy stop implementation is introduced. Boot-register access follows separately.

After KVM_RUN, normalize port I/O, MMIO, interruptions, halt and system exits. Reject repeated port transfers, unknown system events and unsupported exits. Device buffers borrow the vCPU mapping. For an outstanding access, complete_pending_io sets immediate_exit, re-enters KVM, clears the flag, and consumes pending state only on EINTR. With no outstanding access it is a no-op. Preserve errors for failed completion and prevent another guest instruction from running.

Alternatives: a single complete backend would exceed the 400-line review limit; split at working facade boundaries. Returning raw descriptors would let callers bypass ownership and completion rules; keep them private. Synthesizing boot state in the execution layer would mix machine policy with host mechanism; leave it to the boot slice.

Validation: unit tests exercise production exit normalization and completion state, including read-buffer writeback, rejected repeated I/O, errors and no-op completion. Existing ignored KVM tests must exercise the facade and verify instruction-pointer progress. Run the repository's unit, formatting and Clippy targets, cross-check Linux x86_64, and run the bounded hardware target on a KVM-capable host. Local cross-compilation is not hardware qualification.

## Steps

- [ ] Design and research — PR: pending; depends on #1576 (merged); estimate: 50 changed lines. Done when the linked design and source references are reviewed and the PR lands.
- [ ] vCPU creation, exit normalization and pending-I/O completion — PR: pending; depends on design; estimate: 399 changed lines. Done when focused unit tests and real-KVM execution/completion assertions pass and the PR lands.
- [ ] Kick handle and shared trait implementation — PR: pending; depends on slice 1; estimate: 300–390 changed lines. Include race-controlled tests for kicks before entry, during execution and after drop, plus IRQ forwarding. Done when tests and hardware stop qualification pass and the PR lands.
- [ ] x86 boot-register access — PR: pending; depends on slice 2; estimate: 250–390 changed lines. Add architecture-specific register operations needed by the loader, keeping machine layout outside the backend. Done when register round-trip and configured-entry hardware tests pass and the PR lands.

Dependent PRs will use native GitHub stacks if their predecessors remain unmerged. Remeasure each slice before publication and split further if necessary.

## Open questions

The kick slice must settle signal ownership with the embedding process before implementation; no process-global signal handler is installed by slice 1.

## Implementation history

- 2026-09-25 — #1576 merged; execution still uses a raw descriptor only inside its hardware test. Start the execution facade slice.
