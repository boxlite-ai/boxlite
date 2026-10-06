## TL;DR

Validate an x86_64 `vmlinux`, load its segments into owned guest RAM, and prove that a real KVM vCPU can read the loaded bytes.

## Scope and acceptance

Design recorded on 2026-10-06 under [M1](https://github.com/boxlite-ai/boxlite/issues/1698).
This is a Linux x86_64 loading increment. It does not start Linux, prepare
boot parameters, load an initramfs, or implement devices and worker lifecycle.

- Accept little-endian ELF64 executables for x86_64, with a physical entry
  inside a file-backed executable segment.
- Allocate 1–3072 MiB of fresh contiguous RAM at GPA zero. Reserve the first
  MiB for later boot structures; all kernel segments must fit above it.
- Check every loadable segment before allocating or writing RAM. Reject truncated
  headers/payloads, address overflow, overlapping segments, and invalid entries.
- Copy file-backed bytes to `p_paddr`; leave all BSS bytes zero, including
  segments with no file-backed bytes.
- Require a real KVM guest to return bytes read from the loaded native kernel.
  Missing KVM or a missing kernel is a failure in this explicit test.

## Related work and lessons

| Source inspected | Mechanism and local decision |
| --- | --- |
| [Firecracker `arch/x86_64/mod.rs:500–530`](https://github.com/firecracker-microvm/firecracker/blob/68698adfee9b252df130b7a98e3ba04eb81f0f54/src/vmm/src/arch/x86_64/mod.rs#L500) | Delegates ELF copying to rust-vmm and returns an entry for separate boot setup. Reuse that separation; leave its bzImage fallback and PVH support out of this increment. |
| [linux-loader `elf/mod.rs:143–162, 203–299`](https://github.com/rust-vmm/linux-loader/blob/f950496af619300acc40181bb505e6c64c22e4d9/src/loader/elf/mod.rs#L143) | Loads at physical segment addresses through volatile guest-memory operations. Its checks do not establish architecture, non-overlap, full BSS bounds, or an entry inside executable bytes. Add a bounded preflight over the same immutable input slice. |
| [vm-memory `mmap/mod.rs:208`](https://github.com/rust-vmm/vm-memory/blob/b6404d240d639a231abcd2b2db5a4b79ca43059c/src/mmap/mod.rs#L208) | Owns anonymous mmap regions and provides guest-memory access. Reuse it rather than adding local mmap/munmap and volatile-pointer code. |
| [ELF ABI, Program Header: `PT_LOAD`, `p_align`](https://refspecs.linuxfoundation.org/elf/gabi4+/ch5.pheader.html) | File size cannot exceed memory size; the remainder is zero. Alignment relates virtual addresses to file offsets, not physical addresses. Preserve the native kernel's valid per-CPU segment where those physical offsets differ. |

The local image has four loadable segments and physical entry `0x1000000`.
Its highest segment ends at `0x1c26000`; 128 MiB is sufficient for the probe.
These are observations of the local artifact, not hard-coded loader requirements.

Keeping only the existing build tooling cannot prove any loading behavior.
A separate ELF copier would duplicate rust-vmm. A general firmware or Linux
boot implementation would extend beyond this loading check.

## How it works

`memory::KernelMemory::load(image, ram_mib)` owns the preparation sequence:
validate RAM size, preflight ELF, allocate zero-filled memory, invoke
`linux-loader::Elf::load`, and return the memory with entry/end addresses.
Errors discard the allocation. Reloading into existing RAM is not supported.

Preflight decodes only the fixed ELF and program headers. Segment ranges use
checked arithmetic; sorting physical ranges makes overlap checks bounded.
Passing the same borrowed input to preflight and the loader avoids a file
changing between validation and copying. Section tables and notes are unused;
PVH interpretation is disabled with a zero relocation offset.

The implementation stays crate-visible until the VM constructor is connected.
Tests call the production preparation path; the VM/vCPU lifecycle entry points
remain placeholders. No new public VM API is exposed.

For the hardware probe, retain RAM until both the vCPU and VM are dropped,
including during unwinding. Use vm-memory operations for all guest RAM access.
A test-only protected-mode program reads kernel bytes and writes them to a
test I/O port. It does not execute the Linux entry point.

## Validation

| Claim or risk | Planned check |
| --- | --- |
| Correct segment placement and BSS | Multi-segment fixture, physical/virtual addresses differing, BSS-only segment, untouched gaps, exact end/entry checks |
| Reject malformed input safely | Header/class/architecture/type, truncation, segment bounds/overlap/overflow, entry in a gap/data/BSS, invalid RAM size |
| Native artifact is actually loaded | Compare each loaded segment against file bytes and check every BSS byte using the existing native `vmlinux` |
| KVM sees the same allocation | One vCPU reads the native kernel bytes and returns the expected I/O exit; a 60-second process timeout bounds failures |
| Existing behavior remains valid | VMM unit tests, formatting, Clippy, existing KVM hardware tests |

Observed after implementation on 2026-10-06:

- The 11 new loader unit tests passed; the full hypervisor/VMM unit run passed
  28 tests, with hardware cases reserved for their explicit targets.
- The native-image KVM probe passed: four segments, entry `0x1000000`, end
  `0x1c26000`, and guest checksum `0x497361e6` matching the image bytes.
- Clippy, Rust formatting, and `make help` passed.
- The existing KVM suite passed 7/8 cases. `kick_before_entry_preserves_registers_and_dropped_handles_are_inert`
  failed at `src/hypervisor/src/kvm/vm.rs:309` with `KVM_RUN` returning `ENOSPC`.
  An unmodified `main` worktree at `3a9b6c4e` reproduced the same failure;
  investigating it remains separate from kernel loading.

Linux startup, serial output, `BOXLITE_M1_OK`, and M1 stop/reset behavior still
need later validation. The successful probe did not execute the Linux entry.
