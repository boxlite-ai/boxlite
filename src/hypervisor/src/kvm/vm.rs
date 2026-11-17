// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    io,
    os::fd::AsRawFd,
    sync::{Arc, Mutex},
};

use kvm_bindings::{KVM_API_VERSION, KVM_PIT_SPEAKER_DUMMY, kvm_pit_config};
use kvm_ioctls::{Cap, Kvm, VmFd};

use super::KvmVcpu;
use super::memory::{MAX_PAGES_PER_SLOT, MemorySlots};
use crate::{Error, MemoryRegion, Result};

/// An x86_64 KVM VM with an in-kernel interrupt controller and timer.
///
/// Memory backing remains owned by the caller, under the same lifetime contract
/// as [`crate::Vm::map_memory`]. Dropping this value closes the VM descriptor.
#[derive(Debug)]
pub struct KvmVm {
    fd: VmFd,
    slots: Mutex<MemorySlots>,
    run_size: usize,
    kick_signal: i32,
    cpuid: Vec<crate::X86CpuidEntry>,
    msr_indices: Arc<[u32]>,
}

/// A checked KVM system handle and the supported CPUID for a prospective VM.
#[derive(Debug)]
pub struct PreparedKvm {
    kvm: Kvm,
    kick_signal: i32,
    cpuid: Vec<crate::X86CpuidEntry>,
}

impl PreparedKvm {
    fn open(kick_signal: i32) -> io::Result<Self> {
        super::kick::validate_signal(kick_signal)?;
        let kvm = Kvm::new().map_err(|error| {
            let source = io::Error::from_raw_os_error(error.errno());
            if matches!(source.raw_os_error(), Some(libc::ENOENT | libc::ENODEV)) {
                io::Error::new(io::ErrorKind::Unsupported, source)
            } else {
                source
            }
        })?;
        let version = kvm.get_api_version();
        if version != KVM_API_VERSION as i32 {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                format!("KVM API version {version}; expected {KVM_API_VERSION}"),
            ));
        }
        // Reject unsupported hosts before allocating a partially usable VM.
        // ImmediateExit lets the shutdown path complete I/O without resuming code.
        for capability in [
            Cap::UserMemory,
            Cap::Irqchip,
            Cap::Pit2,
            Cap::SetTssAddr,
            Cap::ImmediateExit,
        ] {
            if !kvm.check_extension(capability) {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    format!("KVM capability {capability:?} is unavailable"),
                ));
            }
        }
        let cpuid = super::features::supported_cpuid(&kvm)?;
        Ok(Self {
            kvm,
            kick_signal,
            cpuid,
        })
    }

    /// KVM-supported guest CPUID before the VMM applies guest topology/policy.
    pub fn supported_cpuid(&self) -> &[crate::X86CpuidEntry] {
        &self.cpuid
    }

    fn create(self) -> io::Result<KvmVm> {
        let Self {
            kvm,
            kick_signal,
            cpuid,
        } = self;
        // SAFETY: sysconf has no pointer arguments and does not modify memory.
        let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if page_size <= 0 {
            return Err(io::Error::other("cannot determine the host page size"));
        }
        let fd = kvm.create_vm().map_err(io::Error::from)?;
        // Intel KVM reserves three pages below 4 GiB for real-mode emulation.
        // Keep them in the architecture's MMIO hole, clear of RAM and devices.
        fd.set_tss_address(0xfffb_d000).map_err(io::Error::from)?;
        // x86 KVM requires the IRQ chip before creating any vCPU.
        fd.create_irq_chip().map_err(io::Error::from)?;
        fd.create_pit2(kvm_pit_config {
            flags: KVM_PIT_SPEAKER_DUMMY,
            ..Default::default()
        })
        .map_err(io::Error::from)?;
        Ok(KvmVm {
            fd,
            slots: Mutex::new(MemorySlots::new(kvm.get_nr_memslots(), page_size as usize)),
            run_size: kvm.get_vcpu_mmap_size().map_err(io::Error::from)?,
            kick_signal,
            cpuid,
            msr_indices: kvm
                .get_msr_index_list()
                .map_err(io::Error::from)?
                .as_slice()
                .into(),
        })
    }
}

impl KvmVm {
    /// Opens `/dev/kvm`, verifies the required API, and creates the empty VM.
    pub fn new() -> Result<Self> {
        Self::from_prepared(Self::prepare()?)
    }

    /// Selects an application-reserved realtime signal for vCPU workers.
    /// It must retain its default disposition and be unblocked before creation.
    pub fn with_kick_signal(signal: i32) -> Result<Self> {
        Self::from_prepared(PreparedKvm::open(signal).map_err(Error::CreateVm)?)
    }

    /// Opens `/dev/kvm`, verifies the required API and queries supported CPUID
    /// without creating a VM. Uses the default vCPU kick signal.
    pub fn prepare() -> Result<PreparedKvm> {
        PreparedKvm::open(libc::SIGRTMIN() + 1).map_err(Error::CreateVm)
    }

    /// Creates the VM on a prepared KVM system handle and retains its CPUID.
    pub fn from_prepared(prepared: PreparedKvm) -> Result<Self> {
        prepared.create().map_err(Error::CreateVm)
    }

    /// Captures the global platform without entering any vCPU. The caller must
    /// stop all vCPUs/IRQ producers and complete userspace I/O first.
    pub fn save_state(&self) -> Result<crate::X86VmState> {
        let capture = || -> io::Result<_> {
            let mut irqchips = std::array::from_fn(|chip_id| kvm_bindings::kvm_irqchip {
                chip_id: chip_id as u32,
                ..Default::default()
            });
            for chip in &mut irqchips {
                self.fd.get_irqchip(chip).map_err(io::Error::from)?;
            }
            Ok(crate::X86VmState {
                // SAFETY: each buffer was fully zeroed before GET_IRQCHIP.
                irqchips: irqchips.map(|chip| unsafe {
                    match chip.chip_id {
                        0 | 1 => crate::X86IrqchipState::pic(chip.chip_id, chip.chip.pic),
                        _ => crate::X86IrqchipState::ioapic(chip.chip.ioapic),
                    }
                }),
                pit: Some(self.fd.get_pit2().map_err(io::Error::from)?),
                clock: self.fd.get_clock().map_err(io::Error::from)?,
            })
        };
        capture()
            .map_err(|e| Error::CreateVm(io::Error::new(e.kind(), format!("save VM state: {e}"))))
    }

    /// Fully overwrites an identically configured stopped VM; see [`crate::X86VmState`].
    /// On an ioctl failure,
    /// discard the destination: KVM cannot roll back a partially restored VM.
    ///
    /// Within this platform-state call, restore IRQ chips before PIT programming
    /// so timer interrupts have their captured sinks, then restore the VM clock.
    /// Per-vCPU TSC state is restored separately by [`KvmVcpu::restore_state`];
    /// do not enter any vCPU until all platform, device and vCPU state is installed.
    pub fn restore_state(&self, state: &crate::X86VmState) -> Result<()> {
        let restore = || -> io::Result<()> {
            for chip in &state.irqchips {
                self.fd
                    .set_irqchip(chip.as_kvm())
                    .map_err(io::Error::from)?;
            }
            if let Some(pit) = &state.pit {
                self.fd.set_pit2(pit).map_err(io::Error::from)?;
            }
            // Do not add wall-clock time spent suspended to the guest clock.
            let clock = kvm_bindings::kvm_clock_data {
                flags: state.clock.flags & !kvm_bindings::KVM_CLOCK_REALTIME,
                ..state.clock
            };
            self.fd.set_clock(&clock).map_err(io::Error::from)
        };
        restore().map_err(|e| {
            Error::CreateVm(io::Error::new(e.kind(), format!("restore VM state: {e}")))
        })
    }

    /// KVM-supported guest CPUID before the VMM applies guest topology/policy.
    pub fn supported_cpuid(&self) -> &[crate::X86CpuidEntry] {
        &self.cpuid
    }

    /// Creates a vCPU on the thread that will run it, in KVM's reset state.
    pub fn create_vcpu(&self, id: u32) -> Result<KvmVcpu> {
        let create = || {
            let kick = super::kick::WorkerSignal::reserve(id, self.kick_signal)?;
            let fd = self
                .fd
                .create_vcpu(u64::from(id))
                .map_err(io::Error::from)?;
            kick.configure(fd.as_raw_fd())?;
            Ok(KvmVcpu::new(
                fd,
                id,
                self.run_size,
                kick,
                self.fd.check_extension_int(Cap::Xsave2).max(0) as usize,
                Arc::clone(&self.msr_indices),
            ))
        };
        create().map_err(|source| Error::CreateVcpu { id, source })
    }

    /// Registers caller-owned RAM at a guest physical address.
    ///
    /// # Safety
    ///
    /// KVM accesses the original allocation; range checks cannot guarantee its
    /// lifetime or synchronize accesses to its bytes.
    /// The caller must uphold [`crate::Vm::map_memory`]'s backing-memory,
    /// aliasing, synchronization and lifetime requirements.
    pub unsafe fn map_memory(&self, region: &MemoryRegion) -> Result<()> {
        let install = || {
            // Keep validation, slot selection, the ioctl and bookkeeping atomic
            // against other map/unmap calls; this does not protect guest RAM.
            let mut slots = self
                .slots
                .lock()
                .map_err(|_| io::Error::other("KVM memory slot lock is poisoned"))?;
            slots.map_chunks(
                region,
                MAX_PAGES_PER_SLOT,
                |mapping| {
                    // SAFETY: the caller guarantees valid backing memory. MemorySlots
                    // checks the ranges and retains the slot only after KVM accepts it.
                    unsafe { self.fd.set_user_memory_region(mapping) }.map_err(io::Error::from)
                },
                |mapping| {
                    // SAFETY: a zero-sized region deletes the slot; KVM does not
                    // dereference the supplied userspace address.
                    unsafe { self.fd.set_user_memory_region(mapping) }.map_err(io::Error::from)
                },
            )
        };
        install().map_err(|source| Error::MapMemory {
            guest_addr: region.guest_addr,
            size: region.size,
            source,
        })
    }

    /// Removes the slots for the exact region previously passed to `map_memory`.
    /// An unrecorded region is a no-op. A failed removal retains the slot and
    /// its backing-memory requirements.
    pub fn unmap_memory(&self, region: &MemoryRegion) -> Result<()> {
        let remove = || {
            let mut slots = self
                .slots
                .lock()
                .map_err(|_| io::Error::other("KVM memory slot lock is poisoned"))?;
            slots.unmap_chunks(region, |mapping| {
                // SAFETY: a zero-sized region deletes the slot; KVM does not
                // dereference the supplied userspace address.
                unsafe { self.fd.set_user_memory_region(mapping) }.map_err(io::Error::from)
            })
        };
        remove().map_err(|source| Error::UnmapMemory {
            guest_addr: region.guest_addr,
            size: region.size,
            source,
        })
    }

    /// Sets a GSI on the in-kernel interrupt controller, from any thread.
    pub fn set_irq_line(&self, line: u32, level: bool) -> Result<()> {
        self.fd
            .set_irq_line(line, level)
            .map_err(|source| Error::SetIrqLine {
                line,
                source: source.into(),
            })
    }
}

impl crate::Vm for KvmVm {
    type Vcpu = KvmVcpu;

    unsafe fn map_memory(&self, region: &MemoryRegion) -> Result<()> {
        // SAFETY: the trait caller guarantees the same backing-memory contract.
        unsafe { Self::map_memory(self, region) }
    }

    fn unmap_memory(&self, region: &MemoryRegion) -> Result<()> {
        Self::unmap_memory(self, region)
    }

    fn create_vcpu(&self, id: u32) -> Result<Self::Vcpu> {
        Self::create_vcpu(self, id)
    }

    fn set_irq_line(&self, line: u32, level: bool) -> Result<()> {
        Self::set_irq_line(self, line, level)
    }
}

impl crate::X86Vm for KvmVm {
    fn save_state(&self) -> Result<crate::X86VmState> {
        Self::save_state(self)
    }

    fn restore_state(&self, state: &crate::X86VmState) -> Result<()> {
        Self::restore_state(self, state)
    }

    fn supported_cpuid(&self) -> &[crate::X86CpuidEntry] {
        Self::supported_cpuid(self)
    }
}

#[cfg(test)]
mod tests {
    use std::ptr::NonNull;
    use std::sync::{
        atomic::{AtomicU8, Ordering},
        mpsc,
    };
    use std::{
        thread,
        time::{Duration, Instant},
    };

    use kvm_bindings::{KVM_IRQCHIP_IOAPIC, kvm_irqchip, kvm_regs};

    use super::*;
    use crate::{VcpuExit, VcpuHandle};

    struct Ram(NonNull<u8>);

    impl Ram {
        fn new() -> Self {
            // SAFETY: anonymous mmap owns one writable page, released in Drop.
            let pointer = unsafe {
                libc::mmap(
                    std::ptr::null_mut(),
                    4096,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
                    -1,
                    0,
                )
            };
            assert_ne!(pointer, libc::MAP_FAILED);
            Self(NonNull::new(pointer.cast()).unwrap())
        }

        fn region(&self) -> MemoryRegion {
            MemoryRegion {
                guest_addr: 0x1000,
                host_addr: self.0,
                size: 4096,
            }
        }
    }

    impl Drop for Ram {
        fn drop(&mut self) {
            // SAFETY: tests drop their VM and vCPU before this backing page.
            unsafe { libc::munmap(self.0.as_ptr().cast(), 4096) };
        }
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn vm_snapshot_platform_values_survive_restore() {
        let source = KvmVm::new().unwrap();
        let mut programmed = source.save_state().unwrap();
        for (id, mask) in [(0, 0xa5), (1, 0x5a)] {
            // SAFETY: captured wrappers contain completely initialized images.
            let mut pic = unsafe { programmed.irqchips[id].as_kvm().chip.pic };
            pic.imr = mask;
            programmed.irqchips[id] = crate::X86IrqchipState::pic(id as u32, pic);
        }
        let redirection = 0x71 | (1u64 << 16) | (3u64 << 56);
        // SAFETY: captured wrappers contain completely initialized images.
        let mut ioapic = unsafe { programmed.irqchips[2].as_kvm().chip.ioapic };
        ioapic.redirtbl[7].bits = redirection;
        programmed.irqchips[2] = crate::X86IrqchipState::ioapic(ioapic);
        for chip in &programmed.irqchips {
            source.fd.set_irqchip(chip.as_kvm()).unwrap();
        }
        let pit = programmed.pit.as_mut().unwrap();
        pit.flags = kvm_bindings::KVM_PIT_FLAGS_SPEAKER_DATA_ON;
        for (i, channel) in pit.channels.iter_mut().enumerate() {
            channel.count = 0x3456 + i as u32;
            channel.mode = i as u8;
            channel.rw_mode = 3;
            channel.gate = 0;
        }
        source.fd.set_pit2(pit).unwrap();
        let clock_offset = 7 * 24 * 60 * 60 * 1_000_000_000u64;
        source
            .fd
            .set_clock(&kvm_bindings::kvm_clock_data {
                clock: clock_offset,
                ..Default::default()
            })
            .unwrap();
        let mut state = crate::X86Vm::save_state(&source).unwrap();
        assert!(state.clock.clock >= clock_offset);
        let started = Instant::now();
        // A stale wall-clock correlation must not advance the restored clock.
        if state.clock.flags & kvm_bindings::KVM_CLOCK_REALTIME != 0 {
            state.clock.realtime -= 60 * 1_000_000_000;
        }
        let destination = KvmVm::new().unwrap();
        crate::X86Vm::restore_state(&destination, &state).unwrap();
        for (id, expected) in state.irqchips.iter().enumerate() {
            let mut actual = kvm_irqchip {
                chip_id: id as u32,
                ..Default::default()
            };
            destination.fd.get_irqchip(&mut actual).unwrap();
            // SAFETY: GET_IRQCHIP initializes each full union image.
            assert_eq!(unsafe { actual.chip.dummy }, unsafe {
                expected.as_kvm().chip.dummy
            });
        }
        // SAFETY: these chip IDs select the PIC and IOAPIC union members.
        unsafe {
            assert_eq!(state.irqchips[0].as_kvm().chip.pic.imr, 0xa5);
            assert_eq!(state.irqchips[1].as_kvm().chip.pic.imr, 0x5a);
            assert_eq!(
                state.irqchips[2].as_kvm().chip.ioapic.redirtbl[7].bits,
                redirection
            );
        }
        let actual_pit = destination.fd.get_pit2().unwrap();
        assert_eq!(
            actual_pit.flags,
            kvm_bindings::KVM_PIT_FLAGS_SPEAKER_DATA_ON
        );
        for (i, channel) in actual_pit.channels.iter().enumerate() {
            assert_eq!(channel.count, 0x3456 + i as u32);
            assert_eq!(
                (channel.mode, channel.rw_mode, channel.gate),
                (i as u8, 3, 0)
            );
        }
        let actual_clock = destination.fd.get_clock().unwrap();
        assert!(actual_clock.clock >= state.clock.clock);
        assert!(
            actual_clock.clock - state.clock.clock
                < started.elapsed().as_nanos() as u64 + 1_000_000_000
        );
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn vm_snapshot_preserves_unused_pit() {
        let source = KvmVm::new().unwrap();
        let state = source.save_state().unwrap();
        assert!(state.pit.is_some(), "created, unused PIT is not absent");
        let destination = KvmVm::new().unwrap();
        let mut dirty = destination.fd.get_pit2().unwrap();
        dirty.channels[2].count = 0x7654;
        dirty.channels[2].mode = 3;
        destination.fd.set_pit2(&dirty).unwrap();
        destination.restore_state(&state).unwrap();
        let actual = destination.fd.get_pit2().unwrap();
        let mut expected = state.pit.unwrap();
        // SET_PIT2 reloads channels 1/2 against destination host monotonic time;
        // their host timestamps are not restored verbatim by the kernel.
        for i in 1..3 {
            assert!(actual.channels[i].count_load_time >= expected.channels[i].count_load_time);
            expected.channels[i].count_load_time = actual.channels[i].count_load_time;
        }
        assert_eq!(actual.channels, expected.channels);
        assert_eq!(actual.flags, expected.flags);
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_state_runs_on_a_fresh_vcpu() {
        // .code16: load DS=0x10/ES=0x20; enable SSE in CR4; load XMM0 from
        // CS:0x1700 and fill XMM3 with ones; WRMSR KERNEL_GS_BASE=0x12345678;
        // load EAX/EBX/ESI/EDI with distinct values; OUT 0x80.
        // Continuation: store GPRs, selectors, XMM0/XMM3 and RDMSR's result
        // through CS (DS has a nonzero base); OUT 0x81 signals completion.
        let program = [
            0xb8, 0x10, 0x00, 0x8e, 0xd8, 0xb8, 0x20, 0x00, 0x8e, 0xc0, 0x0f, 0x20, 0xe0, 0x66,
            0x0d, 0x00, 0x06, 0x00, 0x00, 0x0f, 0x22, 0xe0, 0x2e, 0xf3, 0x0f, 0x6f, 0x06, 0x00,
            0x17, 0x66, 0x0f, 0x76, 0xdb, 0x66, 0xb9, 0x02, 0x01, 0x00, 0xc0, 0x66, 0xb8, 0x78,
            0x56, 0x34, 0x12, 0x66, 0x31, 0xd2, 0x0f, 0x30, 0x66, 0xb8, 0x44, 0x33, 0x22, 0x11,
            0x66, 0xbb, 0x88, 0x77, 0x66, 0x55, 0x66, 0xbe, 0xcc, 0xbb, 0xaa, 0x99, 0x66, 0xbf,
            0x00, 0xff, 0xee, 0xdd, 0xe6, 0x80, 0x2e, 0x66, 0xa3, 0x00, 0x18, 0x2e, 0x66, 0x89,
            0x1e, 0x04, 0x18, 0x2e, 0x66, 0x89, 0x36, 0x08, 0x18, 0x2e, 0x66, 0x89, 0x3e, 0x0c,
            0x18, 0x8c, 0xd8, 0x2e, 0xa3, 0x10, 0x18, 0x8c, 0xc0, 0x2e, 0xa3, 0x12, 0x18, 0x2e,
            0xf3, 0x0f, 0x7f, 0x06, 0x20, 0x18, 0x2e, 0xf3, 0x0f, 0x7f, 0x1e, 0x30, 0x18, 0x66,
            0xb9, 0x02, 0x01, 0x00, 0xc0, 0x0f, 0x32, 0x2e, 0x66, 0xa3, 0x40, 0x18, 0x2e, 0x66,
            0x89, 0x16, 0x44, 0x18, 0xe6, 0x81,
        ];
        let ram = Ram::new();
        let xmm: [u8; 16] = std::array::from_fn(|i| (i * 13 + 7) as u8);
        // SAFETY: RAM is not yet registered with a VM; both ranges fit.
        unsafe {
            std::ptr::copy_nonoverlapping(program.as_ptr(), ram.0.as_ptr(), program.len());
            std::ptr::copy_nonoverlapping(xmm.as_ptr(), ram.0.as_ptr().add(0x700), xmm.len());
        }
        let vm = KvmVm::new().unwrap();
        // SAFETY: RAM outlives both VMs and their CPUs; only one runs at a time.
        unsafe { vm.map_memory(&ram.region()) }.unwrap();
        let mut source = vm.create_vcpu(0).unwrap();
        source.set_cpu_features(vm.supported_cpuid(), &[]).unwrap();
        let mut segments = source.fd.get_sregs().unwrap();
        segments.cs.base = 0;
        segments.cs.selector = 0;
        source.fd.set_sregs(&segments).unwrap();
        source
            .fd
            .set_regs(&kvm_regs {
                rip: 0x1000,
                rflags: 2,
                ..Default::default()
            })
            .unwrap();
        assert!(matches!(
            source.run().unwrap(),
            VcpuExit::IoOut { port: 0x80, .. }
        ));
        assert!(
            source.save_state().is_err(),
            "pending I/O must not be snapshotted"
        );
        source.complete_pending_io().unwrap();
        let state = crate::X86Vcpu::save_state(&mut source).unwrap();
        assert_eq!(state.regs.rip, 0x104c);
        assert_eq!(state.fpu.xmm[0], xmm);
        drop(source);
        drop(vm);

        let destination_vm = KvmVm::new().unwrap();
        // SAFETY: same lifetime/serialization contract as the source mapping.
        unsafe { destination_vm.map_memory(&ram.region()) }.unwrap();
        let mut destination = destination_vm.create_vcpu(0).unwrap();
        crate::X86Vcpu::restore_state(&mut destination, &state).unwrap();
        assert_eq!(destination.fd.get_regs().unwrap(), state.regs);
        assert_eq!(destination.fd.get_fpu().unwrap(), state.fpu);
        assert_eq!(destination.fd.get_xcrs().unwrap(), state.xcrs);
        assert_eq!(destination.fd.get_debug_regs().unwrap(), state.debug_regs);
        assert_eq!(destination.fd.get_mp_state().unwrap(), state.mp_state);
        // SAFETY: neither CPU is running, and this range is within RAM.
        let output = unsafe { std::slice::from_raw_parts(ram.0.as_ptr().add(0x800), 0x48) };
        assert!(
            output.iter().all(|&byte| byte == 0),
            "restore must not enter the guest"
        );
        // End the host borrow before KVM writes into the page.
        assert!(matches!(
            destination.run().unwrap(),
            VcpuExit::IoOut { port: 0x81, .. }
        ));
        // SAFETY: KVM_RUN has returned; no concurrent guest or host writes.
        let output = unsafe { std::slice::from_raw_parts(ram.0.as_ptr().add(0x800), 0x48) };
        for (offset, expected) in [
            (0, 0x11223344u32),
            (4, 0x55667788),
            (8, 0x99aabbcc),
            (12, 0xddeeff00),
        ] {
            assert_eq!(&output[offset..offset + 4], &expected.to_le_bytes());
        }
        assert_eq!(&output[0x10..0x14], &[0x10, 0, 0x20, 0]);
        assert_eq!(&output[0x20..0x30], &xmm);
        assert_eq!(&output[0x30..0x40], &[0xff; 16]);
        assert_eq!(&output[0x40..0x48], &0x12345678u64.to_le_bytes());
    }

    #[test]
    #[ignore = "requires Linux x86_64 with AVX and access to /dev/kvm"]
    fn snapshot_restores_ymm_high_halves_on_a_fresh_vcpu() {
        use crate::{X86BootRegisters, X86Segment};

        // .code32: enable x87/SSE/AVX in XCR0; VMOVDQU YMM0,[0x1700]; OUT 0x80.
        // After restore: VMOVDQU [0x1800],YMM0; OUT 0x81.
        let program = [
            0x31, 0xc9, 0xb8, 0x07, 0x00, 0x00, 0x00, 0x31, 0xd2, 0x0f, 0x01, 0xd1, 0xc5, 0xfe,
            0x6f, 0x05, 0x00, 0x17, 0x00, 0x00, 0xe6, 0x80, 0xc5, 0xfe, 0x7f, 0x05, 0x00, 0x18,
            0x00, 0x00, 0xe6, 0x81,
        ];
        let ymm: [u8; 32] = std::array::from_fn(|i| (i * 7 + 1) as u8);
        let ram = Ram::new();
        // SAFETY: neither range is registered or concurrently accessed; both fit.
        unsafe {
            std::ptr::copy_nonoverlapping(program.as_ptr(), ram.0.as_ptr(), program.len());
            std::ptr::copy_nonoverlapping(ymm.as_ptr(), ram.0.as_ptr().add(0x700), ymm.len());
        }
        let vm = KvmVm::new().unwrap();
        let leaf1 = vm
            .supported_cpuid()
            .iter()
            .find(|entry| entry.leaf == 1)
            .unwrap();
        assert_ne!(leaf1.ecx & (1 << 28), 0, "test requires AVX");
        // SAFETY: RAM outlives both VMs; only one CPU executes at a time.
        unsafe { vm.map_memory(&ram.region()) }.unwrap();
        let mut source = vm.create_vcpu(0).unwrap();
        source.set_cpu_features(vm.supported_cpuid(), &[]).unwrap();
        source
            .set_boot_registers(&X86BootRegisters {
                rip: 0x1000,
                rflags: 2,
                cr0: 0x11, // Protected mode, ET; EM and TS clear.
                cr4: (1 << 18) | (1 << 10) | (1 << 9), // OSXSAVE, OSXMMEXCPT, OSFXSR.
                code: X86Segment {
                    limit: u32::MAX,
                    selector: 8,
                    attributes: 0xc09b,
                    ..Default::default()
                },
                data: X86Segment {
                    limit: u32::MAX,
                    selector: 16,
                    attributes: 0xc093,
                    ..Default::default()
                },
                ..Default::default()
            })
            .unwrap();
        assert!(matches!(
            source.run().unwrap(),
            VcpuExit::IoOut { port: 0x80, .. }
        ));
        source.complete_pending_io().unwrap();
        let state = source.save_state().unwrap();
        // The standard XSAVE layout starts YMM_Hi128 at byte 576.
        let high: Vec<_> = state.xsave[144..148]
            .iter()
            .flat_map(|word| word.to_le_bytes())
            .collect();
        assert_eq!(high, ymm[16..]);
        drop(source);
        drop(vm);

        let vm = KvmVm::new().unwrap();
        // SAFETY: same backing lifetime and serialized access as above.
        unsafe { vm.map_memory(&ram.region()) }.unwrap();
        let mut destination = vm.create_vcpu(0).unwrap();
        destination.restore_state(&state).unwrap();
        assert!(matches!(
            destination.run().unwrap(),
            VcpuExit::IoOut { port: 0x81, .. }
        ));
        // SAFETY: guest execution has stopped and the output lies within RAM.
        let output = unsafe { std::slice::from_raw_parts(ram.0.as_ptr().add(0x800), 32) };
        assert_eq!(
            &output[16..],
            &ymm[16..],
            "YMM high half lost during restore"
        );
        assert_eq!(output, &ymm);
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn constructor_creates_interrupt_controller_and_timer() {
        let vm = KvmVm::new().unwrap();
        let mut irqchip = kvm_irqchip {
            chip_id: KVM_IRQCHIP_IOAPIC,
            ..Default::default()
        };
        vm.fd.get_irqchip(&mut irqchip).unwrap();
        vm.fd
            .get_pit2()
            .expect("KvmVm::new must create the in-kernel PIT");
        crate::Vm::set_irq_line(&vm, 4, true).unwrap();
        crate::Vm::set_irq_line(&vm, 4, false).unwrap();
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn failed_signal_reservation_does_not_consume_vcpu_id() {
        let vm = KvmVm::new().unwrap();
        let mut blocked = unsafe { std::mem::zeroed::<libc::sigset_t>() };
        let mut original = unsafe { std::mem::zeroed::<libc::sigset_t>() };
        // SAFETY: both signal sets are initialized before libc writes to them.
        unsafe {
            libc::sigemptyset(&mut blocked);
            libc::sigaddset(&mut blocked, vm.kick_signal);
        }
        // SAFETY: pointers refer to live signal sets; this only changes the test worker.
        assert_eq!(
            unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &blocked, &mut original) },
            0
        );

        let first = vm.create_vcpu(0);

        // SAFETY: restore the exact mask before asserting or retrying creation.
        assert_eq!(
            unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, &original, std::ptr::null_mut()) },
            0
        );
        assert!(matches!(
            first,
            Err(Error::CreateVcpu { source, .. })
                if source.kind() == io::ErrorKind::AlreadyExists
        ));
        let vcpu = vm
            .create_vcpu(0)
            .expect("a failed signal reservation must not consume the KVM vCPU id");
        drop(vcpu);
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn kick_before_entry_preserves_registers_and_dropped_handles_are_inert() {
        let vm = KvmVm::new().unwrap();
        let mut vcpu = crate::Vm::create_vcpu(&vm, 0).unwrap();
        let before = vcpu.fd.get_regs().unwrap();
        let handle = crate::Vcpu::handle(&vcpu);
        handle.kick().unwrap();
        assert!(matches!(
            crate::Vcpu::run(&mut vcpu).unwrap(),
            VcpuExit::Interrupted
        ));
        assert_eq!(vcpu.fd.get_regs().unwrap().rip, before.rip);
        crate::Vcpu::complete_pending_io(&mut vcpu).unwrap();
        drop(vcpu);
        handle.kick().unwrap();
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn boot_registers_round_trip_through_kvm() {
        use crate::{X86BootRegisters, X86Segment};

        let vm = KvmVm::new().unwrap();
        let mut vcpu = vm.create_vcpu(0).unwrap();
        // KVM validates long-mode registers against the guest CPUID.
        vcpu.set_cpu_features(vm.supported_cpuid(), &[]).unwrap();
        let code = X86Segment {
            limit: u32::MAX,
            selector: 8,
            attributes: 0xa09b,
            ..Default::default()
        };
        vcpu.set_boot_registers(&X86BootRegisters {
            rip: 0x10_0200,
            rsp: 0x8ff0,
            rsi: 0x7000,
            rflags: 2,
            cr0: 0x8000_0001,
            cr3: 0x9000,
            cr4: 0x20,
            efer: 0x500,
            code,
            data: X86Segment {
                selector: 16,
                attributes: 0xc093,
                ..code
            },
            gdt_base: 0x500,
            gdt_limit: 23,
            ..Default::default()
        })
        .unwrap();
        let regs = vcpu.fd.get_regs().unwrap();
        assert_eq!(
            (regs.rip, regs.rsp, regs.rsi, regs.rflags),
            (0x10_0200, 0x8ff0, 0x7000, 2)
        );
        let special = vcpu.fd.get_sregs().unwrap();
        assert_eq!(
            (special.cr0, special.cr3, special.cr4, special.efer),
            (0x8000_0001, 0x9000, 0x20, 0x500)
        );
        assert_eq!(
            (special.cs.selector, special.cs.l, special.ds.selector),
            (8, 1, 16)
        );
        assert_eq!((special.gdt.base, special.gdt.limit), (0x500, 23));
        let fpu = vcpu.fd.get_fpu().unwrap();
        assert_eq!(fpu.fcw, 0x37f);
        // MXCSR is the seventh dword in the legacy SSE area of XSAVE.
        assert_eq!(vcpu.fd.get_xsave().unwrap().region[6], 0x1f80);
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn cpu_features_round_trip_through_kvm() {
        use crate::X86Msr;
        use kvm_bindings::{KVM_MAX_CPUID_ENTRIES, Msrs, kvm_msr_entry};

        let vm = KvmVm::new().unwrap();
        let mut vcpu = vm.create_vcpu(0).unwrap();
        let mut cpuid = vm.supported_cpuid().to_vec();
        cpuid.iter_mut().find(|entry| entry.leaf == 1).unwrap().ecx |= 1 << 31;
        vcpu.set_cpu_features(
            &cpuid,
            &[X86Msr {
                index: 0x174,
                value: 0x10,
            }],
        )
        .unwrap();
        let actual = vcpu.fd.get_cpuid2(KVM_MAX_CPUID_ENTRIES).unwrap();
        let leaf = actual
            .as_slice()
            .iter()
            .find(|entry| entry.function == 1)
            .unwrap();
        assert_ne!(leaf.ecx & (1 << 31), 0);
        let mut msrs = Msrs::from_entries(&[kvm_msr_entry {
            index: 0x174,
            ..Default::default()
        }])
        .unwrap();
        assert_eq!(vcpu.fd.get_msrs(&mut msrs).unwrap(), 1);
        assert_eq!(msrs.as_slice()[0].data, 0x10);
        assert!(matches!(
            vcpu.set_cpu_features(&[], &[]),
            Err(Error::ConfigureVcpu {
                id: 0,
                operation: "prepare CPUID",
                ..
            })
        ));
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn kick_interrupts_a_guest_that_has_entered_kvm() {
        let (ready, receive_ready) = mpsc::sync_channel(1);
        let (release, receive_release) = mpsc::sync_channel(1);
        let (completed, receive_completed) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let ram = Ram::new();
            // Real mode: mark entry, wait for the host's stop byte, then HLT.
            let program = [
                0xc6, 0x06, 0x00, 0x18, 0x01, 0x80, 0x3e, 0x01, 0x18, 0x01, 0x75, 0xf9, 0xf4,
            ];
            // SAFETY: the guest cannot access the mapping before registration.
            unsafe {
                std::ptr::copy_nonoverlapping(program.as_ptr(), ram.0.as_ptr(), program.len())
            };
            let vm = KvmVm::new().unwrap();
            // SAFETY: ram outlives vm/vcpu, including during unwinding.
            unsafe { crate::Vm::map_memory(&vm, &ram.region()) }.unwrap();
            let mut vcpu = crate::Vm::create_vcpu(&vm, 0).unwrap();
            let mut segments = vcpu.fd.get_sregs().unwrap();
            segments.cs.base = 0;
            segments.cs.selector = 0;
            vcpu.fd.set_sregs(&segments).unwrap();
            vcpu.fd
                .set_regs(&kvm_regs {
                    rip: 0x1000,
                    rflags: 2,
                    ..Default::default()
                })
                .unwrap();
            let marker_address = ram.0.as_ptr() as usize + 0x800;
            ready
                .send((crate::Vcpu::handle(&vcpu), marker_address))
                .unwrap();
            let outcome =
                crate::Vcpu::run(&mut vcpu).map(|exit| matches!(exit, VcpuExit::Interrupted));
            // Keep RAM alive even if KVM returns an unexpected error before the
            // marker. The parent releases it after its last atomic load.
            let _ = receive_release.recv();
            completed.send(outcome).unwrap();
        });
        let (handle, marker_address) = receive_ready.recv_timeout(Duration::from_secs(5)).unwrap();
        // SAFETY: the worker holds RAM until release. x86 byte stores are atomic;
        // there are no overlapping non-atomic host accesses to this marker.
        let marker = unsafe { AtomicU8::from_ptr(marker_address as *mut u8) };
        // SAFETY: the worker holds RAM until release; this byte is separate from
        // the marker and host/guest access it with byte-wide operations.
        let stop = unsafe { AtomicU8::from_ptr((marker_address + 1) as *mut u8) };
        let deadline = Instant::now() + Duration::from_secs(5);
        let entered = loop {
            if marker.load(Ordering::Relaxed) == 1 {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            thread::yield_now();
        };
        let kicked = handle.kick();
        stop.store(1, Ordering::Relaxed);
        release.send(()).unwrap();
        let outcome = receive_completed
            .recv_timeout(Duration::from_secs(5))
            .expect("the guest did not stop after the kick attempt");
        worker.join().unwrap();
        assert!(entered, "the guest never reached its spin loop");
        kicked.unwrap();
        assert!(
            outcome.unwrap(),
            "the running guest did not return Interrupted"
        );
        handle.kick().unwrap();
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn registered_ram_supplies_instructions_to_a_real_vcpu() {
        // mov dx,0x3f8; mov al,'K'; out dx,al; hlt
        let program = [0xba, 0xf8, 0x03, 0xb0, b'K', 0xee, 0xf4];
        let ram = Ram::new();
        // SAFETY: the allocation is large enough and not yet visible to KVM.
        unsafe { std::ptr::copy_nonoverlapping(program.as_ptr(), ram.0.as_ptr(), program.len()) };
        let vm = KvmVm::new().unwrap();
        // SAFETY: ram is uniquely owned and outlives vm and vcpu.
        unsafe { vm.map_memory(&ram.region()) }.unwrap();
        let mut vcpu = vm.create_vcpu(0).unwrap();
        assert!(matches!(
            vm.create_vcpu(0),
            Err(Error::CreateVcpu { id: 0, .. })
        ));
        vcpu.complete_pending_io().unwrap();
        let mut segments = vcpu.fd.get_sregs().unwrap();
        segments.cs.base = 0;
        segments.cs.selector = 0;
        vcpu.fd.set_sregs(&segments).unwrap();
        vcpu.fd
            .set_regs(&kvm_regs {
                rip: 0x1000,
                rflags: 2,
                ..Default::default()
            })
            .unwrap();
        match vcpu.run().unwrap() {
            crate::VcpuExit::IoOut { port, bytes } => {
                assert_eq!(port, 0x3f8);
                assert_eq!(bytes, b"K");
            }
            exit => panic!("unexpected exit: {exit:?}"),
        }
        // The I/O exit leaves instruction completion pending until KVM_RUN.
        // Complete it without reaching HLT, which can wait in the kernel.
        vcpu.complete_pending_io().unwrap();
        assert_eq!(vcpu.fd.get_regs().unwrap().rip, 0x1006);
        vcpu.complete_pending_io().unwrap();
        assert_eq!(vcpu.fd.get_regs().unwrap().rip, 0x1006);
        assert_eq!(vcpu.fd.get_kvm_run().immediate_exit, 0);
        crate::VcpuHandle::kick(&vcpu.handle()).unwrap();
        assert!(matches!(vcpu.run().unwrap(), crate::VcpuExit::Interrupted));
        assert_eq!(vcpu.fd.get_regs().unwrap().rip, 0x1006);
        // Stop this user of the backing page before removing its guest mapping.
        drop(vcpu);
        vm.unmap_memory(&ram.region()).unwrap();
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn removed_memory_can_be_replaced_at_the_same_guest_address() {
        let original = Ram::new();
        let replacement = Ram::new();
        let vm = KvmVm::new().unwrap();
        // SAFETY: each allocation outlives the VM; no vCPU or device accesses it.
        unsafe { vm.map_memory(&original.region()) }.unwrap();
        vm.unmap_memory(&original.region()).unwrap();
        // SAFETY: replacement is a separate allocation with the same lifetime.
        unsafe { vm.map_memory(&replacement.region()) }.unwrap();
        vm.unmap_memory(&replacement.region()).unwrap();
    }
}
