// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    io,
    os::fd::AsRawFd,
    sync::{Arc, Mutex},
};

use kvm_bindings::{
    KVM_API_VERSION, KVM_IRQCHIP_IOAPIC, KVM_IRQCHIP_PIC_MASTER, KVM_IRQCHIP_PIC_SLAVE,
    KVM_PIT_SPEAKER_DUMMY, kvm_clock_data, kvm_pit_config,
};
use kvm_ioctls::{Cap, Kvm, VmFd};

use super::KvmVcpu;
use super::features::{build_snapshot_msr_indices, kvm_msr_index_list};
use super::memory::{MAX_PAGES_PER_SLOT, MemorySlots};
use super::vcpu::{CachedIoError, VcpuSnapshotShared};
use crate::{Error, MemoryRegion, Result};

/// An x86_64 KVM VM with an in-kernel interrupt controller and timer.
///
/// Memory backing remains owned by the caller, under the same lifetime contract
/// as [`crate::Vm::map_memory`]. vCPUs share the VM descriptor for clock sampling.
#[derive(Debug)]
pub struct KvmVm {
    fd: Arc<VmFd>,
    slots: Mutex<MemorySlots>,
    run_size: usize,
    kick_signal: i32,
    cpuid: Vec<crate::X86CpuidEntry>,
    vcpu_snapshot: Arc<VcpuSnapshotShared>,
}

fn parse_xsave2_size(ret: i32, last_err: io::Error) -> io::Result<usize> {
    if ret < 0 {
        return Err(match last_err.raw_os_error() {
            Some(errno) if errno != 0 => last_err,
            _ => io::Error::other(format!(
                "KVM_CHECK_EXTENSION(KVM_CAP_XSAVE2) failed with {ret}"
            )),
        });
    }
    let size = ret as usize;
    let legacy_size = size_of::<kvm_bindings::kvm_xsave>();
    if size != 0 && size < legacy_size {
        return Err(io::Error::other(format!(
            "KVM_CAP_XSAVE2 returned {size} bytes, below the {legacy_size}-byte legacy size"
        )));
    }
    Ok(size)
}

fn xsave2_size(fd: &VmFd) -> io::Result<usize> {
    let ret = fd.check_extension_int(Cap::Xsave2);
    parse_xsave2_size(ret, io::Error::last_os_error())
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
        let msr_indices = kvm_msr_index_list(&kvm)
            .map(|list| build_snapshot_msr_indices(&list))
            .map_err(CachedIoError::from_io);
        let fd = Arc::new(fd);
        let vcpu_snapshot = Arc::new(VcpuSnapshotShared::new(Arc::clone(&fd), msr_indices));
        Ok(KvmVm {
            fd,
            slots: Mutex::new(MemorySlots::new(kvm.get_nr_memslots(), page_size as usize)),
            run_size: kvm.get_vcpu_mmap_size().map_err(io::Error::from)?,
            kick_signal,
            cpuid,
            vcpu_snapshot,
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

    /// Captures the global platform and starts a new snapshot round. Stop all
    /// vCPUs and IRQ producers, complete userspace I/O, then save this image
    /// before capturing each vCPU once in the round.
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
        let state = capture().map_err(|source| Error::vm_state("save", source))?;
        self.vcpu_snapshot.record_tsc_save_clock(state.clock.clock);
        Ok(state)
    }

    /// Sets the VM clock offset after RAM mapping, before restoring any vCPU.
    pub fn restore_before_vcpus(&self, state: &crate::X86VmState) -> Result<()> {
        // Zero flags exclude suspend time and are accepted by older kernels.
        self.fd
            .set_clock(&kvm_clock_data {
                flags: 0,
                ..state.clock
            })
            .map_err(|source| Error::vm_state("restore", source.into()))?;
        self.vcpu_snapshot.clear_tsc_save_anchor();
        self.vcpu_snapshot
            .record_tsc_restore_clock(state.clock.clock);
        Ok(())
    }

    /// Restores IRQ chips and then the PIT after all vCPUs are restored and
    /// before any guest entry. Discard the destination after an ioctl failure.
    pub fn restore_after_vcpus(&self, state: &crate::X86VmState) -> Result<()> {
        let restore = || -> io::Result<()> {
            let ids = state.irqchips.each_ref().map(|chip| chip.as_kvm().chip_id);
            if ids
                != [
                    KVM_IRQCHIP_PIC_MASTER,
                    KVM_IRQCHIP_PIC_SLAVE,
                    KVM_IRQCHIP_IOAPIC,
                ]
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "expected IRQ chip IDs in PIC master, PIC slave, IOAPIC order",
                ));
            }
            for chip in &state.irqchips {
                self.fd
                    .set_irqchip(chip.as_kvm())
                    .map_err(io::Error::from)?;
            }
            if let Some(pit) = &state.pit {
                self.fd.set_pit2(pit).map_err(io::Error::from)?;
            }
            Ok(())
        };
        restore().map_err(|source| Error::vm_state("restore", source))
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
            self.vcpu_snapshot.clear_tsc_save_anchor();
            // KVM locks guest XSTATE permissions when it creates the first vCPU.
            let xsave_size = xsave2_size(&self.fd).map_err(CachedIoError::from_io);
            kick.configure(fd.as_raw_fd())?;
            Ok(KvmVcpu::new(
                fd,
                id,
                self.run_size,
                kick,
                xsave_size,
                Arc::clone(&self.vcpu_snapshot),
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

    fn restore_before_vcpus(&self, state: &crate::X86VmState) -> Result<()> {
        Self::restore_before_vcpus(self, state)
    }

    fn restore_after_vcpus(&self, state: &crate::X86VmState) -> Result<()> {
        Self::restore_after_vcpus(self, state)
    }

    fn supported_cpuid(&self) -> &[crate::X86CpuidEntry] {
        Self::supported_cpuid(self)
    }
}

#[cfg(test)]
mod tests {
    use std::ptr::NonNull;
    use std::sync::{
        Barrier,
        atomic::{AtomicU8, Ordering},
        mpsc,
    };
    use std::{
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    use kvm_bindings::{Msrs, kvm_irqchip, kvm_msr_entry, kvm_regs};

    use super::super::features::{MSR_IA32_TSC, MSR_IA32_TSC_DEADLINE, snapshot_msrs};
    use super::*;
    use crate::{VcpuExit, VcpuHandle, X86Msr};

    fn snapshot_cpuid(vm: &KvmVm) -> Vec<crate::X86CpuidEntry> {
        let mut cpuid = vm.supported_cpuid().to_vec();
        for entry in &mut cpuid {
            if entry.leaf == 7 && (!entry.subleaf_required || entry.subleaf == 0) {
                entry.ecx &= !(1 << 7); // CET shadow stack is outside the snapshot contract.
            }
        }
        cpuid
    }

    fn saved_tsc(state: &crate::X86VcpuState) -> u64 {
        state
            .msrs
            .iter()
            .find(|msr| msr.index == MSR_IA32_TSC)
            .unwrap()
            .data
    }

    fn assert_vcpu_save_error(error: Error, message: &str) {
        assert!(
            matches!(error, Error::ConfigureVcpu { operation: "save CPU state", ref source, .. }
            if source.kind() == io::ErrorKind::Other && source.to_string() == message),
            "{error:?}"
        );
    }

    #[test]
    fn parse_xsave2_size_preserves_negative_ioctl_errno() {
        let result = parse_xsave2_size(-1, io::Error::from_raw_os_error(libc::ENOTTY));
        assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::ENOTTY));
        for error in [io::Error::from_raw_os_error(0), io::Error::other("unknown")] {
            let error = parse_xsave2_size(-2, error).unwrap_err();
            assert_eq!(
                error.to_string(),
                "KVM_CHECK_EXTENSION(KVM_CAP_XSAVE2) failed with -2"
            );
        }
    }

    #[test]
    fn parse_xsave2_size_accepts_unsupported_and_valid_sizes() {
        let parse = |ret| parse_xsave2_size(ret, io::Error::from_raw_os_error(libc::ENOTTY));
        assert_eq!(parse(0).unwrap(), 0);
        assert_eq!(parse(4096).unwrap(), 4096);
        assert_eq!(parse(8192).unwrap(), 8192);
    }

    #[test]
    fn parse_xsave2_size_rejects_sizes_below_the_legacy_abi() {
        for size in [1, 4095] {
            let error = parse_xsave2_size(size, io::Error::from_raw_os_error(0)).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::Other);
            assert!(
                error
                    .to_string()
                    .contains("below the 4096-byte legacy size")
            );
        }
    }

    /// Replace the owned VM fd with a valid non-KVM fd to force ioctl failure.
    fn vm_with_failing_ioctls() -> (KvmVm, crate::X86VmState) {
        let vm = KvmVm::new().unwrap();
        let state = vm.save_state().unwrap();
        let file = std::fs::File::open("/dev/null").unwrap();
        // SAFETY: both fds are valid and distinct; vm exclusively owns the
        // destination fd and continues to own its replacement until drop.
        assert_eq!(
            unsafe { libc::dup2(file.as_raw_fd(), vm.fd.as_raw_fd()) },
            vm.fd.as_raw_fd()
        );
        (vm, state)
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn xsave2_size_propagates_extension_query_error() {
        let (vm, _) = vm_with_failing_ioctls();
        let error = xsave2_size(&vm.fd).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::ENOTTY));
    }

    fn assert_vm_state_ioctl_error(error: Error, operation: &'static str) {
        let cause = std::error::Error::source(&error)
            .and_then(|source| source.downcast_ref::<io::Error>())
            .expect("original ioctl error");
        assert_eq!(cause.raw_os_error(), Some(libc::ENOTTY));
        assert_eq!(
            cause.kind(),
            io::Error::from_raw_os_error(libc::ENOTTY).kind()
        );
        assert!(std::error::Error::source(cause).is_none());
        assert_eq!(error.to_string(), format!("failed to {operation} VM state"));
        assert!(matches!(error, Error::VmState { operation: actual, .. } if actual == operation));
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn save_vm_state_preserves_the_ioctl_error() {
        let (vm, _) = vm_with_failing_ioctls();
        assert_vm_state_ioctl_error(vm.save_state().unwrap_err(), "save");
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn restore_vm_state_preserves_the_ioctl_error() {
        let (vm, state) = vm_with_failing_ioctls();
        assert_vm_state_ioctl_error(vm.restore_before_vcpus(&state).unwrap_err(), "restore");
        assert_vm_state_ioctl_error(vm.restore_after_vcpus(&state).unwrap_err(), "restore");
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn restore_after_vcpus_rejects_invalid_irqchip_ids() {
        let (vm, mut state) = vm_with_failing_ioctls();
        for ids in [
            [KVM_IRQCHIP_PIC_MASTER; 3],
            [KVM_IRQCHIP_PIC_MASTER, KVM_IRQCHIP_PIC_SLAVE, u32::MAX],
            [
                KVM_IRQCHIP_PIC_SLAVE,
                KVM_IRQCHIP_PIC_MASTER,
                KVM_IRQCHIP_IOAPIC,
            ],
        ] {
            state.irqchips = ids.map(|id| crate::X86IrqchipState::pic(id, Default::default()));
            // Any write would fail with ENOTTY instead of the validation error.
            let error = vm.restore_after_vcpus(&state).unwrap_err();
            assert!(
                matches!(
                    error,
                    Error::VmState { operation: "restore", ref source }
                        if source.kind() == io::ErrorKind::InvalidInput
                            && source.raw_os_error().is_none()
                ),
                "IRQ chip IDs {ids:?}: {error:?}"
            );
        }
    }

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
    fn snapshot_msr_probe_error_does_not_prevent_vcpu_creation_or_run() {
        let ram = Ram::new();
        // SAFETY: the two-byte OUT 0x80, AL instruction fits in private RAM.
        unsafe { ram.0.as_ptr().cast::<[u8; 2]>().write([0xe6, 0x80]) };
        let mut vm = KvmVm::new().unwrap();
        // SAFETY: RAM outlives the VM and its vCPU.
        unsafe { vm.map_memory(&ram.region()) }.unwrap();
        vm.vcpu_snapshot = Arc::new(VcpuSnapshotShared::new(
            Arc::clone(&vm.fd),
            Err(CachedIoError::from_io(io::Error::from_raw_os_error(
                libc::EPERM,
            ))),
        ));
        let mut cpu = vm.create_vcpu(0).unwrap();
        cpu.set_cpu_features(&snapshot_cpuid(&vm), &[]).unwrap();
        let mut sregs = cpu.fd.get_sregs().unwrap();
        sregs.cs.base = 0;
        sregs.cs.selector = 0;
        cpu.fd.set_sregs(&sregs).unwrap();
        cpu.fd
            .set_regs(&kvm_regs {
                rip: ram.region().guest_addr,
                rflags: 2,
                ..Default::default()
            })
            .unwrap();
        assert!(matches!(
            cpu.run().unwrap(),
            VcpuExit::IoOut { port: 0x80, .. }
        ));
        cpu.complete_pending_io().unwrap();
        vm.save_state().unwrap();
        let error = cpu.save_state().unwrap_err();
        assert!(
            matches!(error, Error::ConfigureVcpu { operation: "save CPU state", ref source, .. }
            if source.raw_os_error() == Some(libc::EPERM))
        );
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_restore_preserves_mtrr_def_type_and_mtrrs() {
        let mtrrs = [
            (0x2ff, 0x806),
            (0x250, 0x0606_0606_0606_0606),
            (0x200, 0x20_0006),
            (0x201, 0xffe0_0800),
        ];
        // .code16: MOV ECX,0x2ff; RDMSR; OUT 0x80,EAX.
        let program = [
            0x66, 0xb9, 0xff, 0x02, 0x00, 0x00, 0x0f, 0x32, 0x66, 0xe7, 0x80,
        ];
        let ram = Ram::new();
        // SAFETY: the program fits in the private, unmapped page.
        unsafe { std::ptr::copy_nonoverlapping(program.as_ptr(), ram.0.as_ptr(), program.len()) };
        let vm = KvmVm::new().unwrap();
        let mut cpu = vm.create_vcpu(0).unwrap();
        cpu.set_cpu_features(
            &snapshot_cpuid(&vm),
            &mtrrs.map(|(index, value)| X86Msr { index, value }),
        )
        .unwrap();
        let mut sregs = cpu.fd.get_sregs().unwrap();
        sregs.cs.base = 0;
        sregs.cs.selector = 0;
        cpu.fd.set_sregs(&sregs).unwrap();
        cpu.fd
            .set_regs(&kvm_regs {
                rip: 0x1000,
                rflags: 2,
                ..Default::default()
            })
            .unwrap();
        let platform = vm.save_state().unwrap();
        let state = cpu.save_state().unwrap();
        drop(cpu);

        let destination = KvmVm::new().unwrap();
        // SAFETY: the page outlives the destination VM and vCPU.
        unsafe { destination.map_memory(&ram.region()) }.unwrap();
        destination.restore_before_vcpus(&platform).unwrap();
        let mut cpu = destination.create_vcpu(0).unwrap();
        cpu.restore_state(&state).unwrap();
        destination.restore_after_vcpus(&platform).unwrap();
        let mut readback = Msrs::from_entries(&mtrrs.map(|(index, _)| kvm_msr_entry {
            index,
            ..Default::default()
        }))
        .unwrap();
        assert_eq!(cpu.fd.get_msrs(&mut readback).unwrap(), mtrrs.len());
        for (entry, (index, value)) in readback.as_slice().iter().zip(mtrrs) {
            assert_eq!((entry.index, entry.data), (index, value));
        }
        match cpu.run().unwrap() {
            VcpuExit::IoOut { port: 0x80, bytes } => assert_eq!(bytes, &0x806u32.to_le_bytes()),
            exit => panic!("expected guest MTRR_DEF_TYPE, got {exit:?}"),
        }
    }

    #[test]
    #[ignore = "requires Linux x86_64 with KVM TSC offset controls"]
    fn snapshot_restore_preserves_inter_vcpu_tsc_skew_and_sync() {
        #[derive(Clone, Copy, Debug)]
        enum CaptureOrder {
            VmFirst,
            ReorderedRetry,
            NoopIoCompletion,
        }

        let pause = Duration::from_millis(5);
        for (order, skew_ms) in [
            (CaptureOrder::VmFirst, 100),
            (CaptureOrder::VmFirst, 0),
            (CaptureOrder::ReorderedRetry, 0),
            (CaptureOrder::NoopIoCompletion, 0),
        ] {
            let vm = KvmVm::new().unwrap();
            // Spawn both vCPU owners from the test thread so each inherits an unblocked kick signal.
            let states = thread::scope(|scope| {
                let (send_offset, wait_for_offset) = mpsc::channel();
                let (ready, prepared) = mpsc::channel();
                let (capture, wait_for_capture) = mpsc::channel();
                let (saved, receive_state) = mpsc::channel();
                let vm = &vm;
                scope.spawn(move || {
                    let Ok(offset) = wait_for_offset.recv() else {
                        return;
                    };
                    let mut second = vm.create_vcpu(1).unwrap();
                    second.set_cpu_features(&snapshot_cpuid(vm), &[]).unwrap();
                    assert!(second.has_tsc_offset().unwrap());
                    assert!(second.set_tsc_offset(offset).unwrap());
                    assert_eq!(second.get_tsc_offset().unwrap(), Some(offset));
                    ready.send(()).unwrap();
                    if wait_for_capture.recv().is_ok() {
                        if matches!(order, CaptureOrder::NoopIoCompletion) {
                            second.complete_pending_io().unwrap();
                        }
                        saved.send(second.save_state().unwrap()).unwrap();
                    }
                });
                let capture_first = move || {
                    let mut first = vm.create_vcpu(0).unwrap();
                    first.set_cpu_features(&snapshot_cpuid(vm), &[]).unwrap();
                    first.has_tsc_offset().unwrap();
                    let offset = first.get_tsc_offset().unwrap()?;
                    let skew = u64::from(first.fd.get_tsc_khz().unwrap()) * skew_ms;
                    send_offset.send(offset.wrapping_add(skew)).unwrap();
                    prepared.recv().unwrap();
                    let save_second = || {
                        capture.send(()).unwrap();
                        receive_state.recv().unwrap()
                    };
                    let platform = vm.save_state().unwrap();
                    let (first_state, second_state) =
                        if matches!(order, CaptureOrder::ReorderedRetry) {
                            assert_vcpu_save_error(
                                first.save_state_with_pending_io().unwrap_err(),
                                "complete pending I/O before saving",
                            );
                            let second_state = save_second();
                            thread::sleep(pause);
                            let first_state = first.save_state().unwrap();
                            assert_vcpu_save_error(
                                first.save_state().unwrap_err(),
                                "save VM state before recapturing vCPU state",
                            );
                            (first_state, second_state)
                        } else {
                            let first_state = first.save_state().unwrap();
                            thread::sleep(pause);
                            (first_state, save_second())
                        };
                    Some((platform, first_state, second_state, skew))
                };
                scope.spawn(capture_first).join().unwrap()
            });
            let Some((platform, first_state, second_state, skew)) = states else {
                eprintln!("skipping TSC snapshot test: KVM does not expose TSC offset controls");
                return;
            };
            assert_eq!(first_state.tsc_khz, second_state.tsc_khz);
            assert_eq!(
                saved_tsc(&second_state).wrapping_sub(saved_tsc(&first_state)),
                skew,
                "{order:?} capture"
            );
            let destination = KvmVm::new().unwrap();
            destination.restore_before_vcpus(&platform).unwrap();
            let restore_offset = |id, state: &crate::X86VcpuState| {
                let mut cpu = destination.create_vcpu(id).unwrap();
                cpu.restore_state(state).unwrap();
                cpu.get_tsc_offset().unwrap().unwrap()
            };
            let (first_offset, second_offset) = thread::scope(|scope| {
                let (restored_first, wait_for_first) = mpsc::channel();
                let first = scope.spawn(move || {
                    let offset = restore_offset(0, &first_state);
                    restored_first.send(()).unwrap();
                    offset
                });
                let second = scope.spawn(move || {
                    wait_for_first.recv().unwrap();
                    thread::sleep(pause);
                    restore_offset(1, &second_state)
                });
                (first.join().unwrap(), second.join().unwrap())
            });
            assert_eq!(
                second_offset,
                first_offset.wrapping_add(skew),
                "{order:?} restore"
            );
        }
    }

    #[test]
    #[ignore = "requires Linux x86_64 with KVM TSC offset controls"]
    fn consecutive_paused_vm_first_saves_use_each_rounds_vm_clock() {
        let vm = KvmVm::new().unwrap();
        let mut cpu = vm.create_vcpu(0).unwrap();
        cpu.set_cpu_features(&snapshot_cpuid(&vm), &[]).unwrap();
        if !cpu.has_tsc_offset().unwrap() {
            eprintln!("skipping clock correlation test: KVM does not expose TSC offset controls");
            return;
        }

        let first_vm = vm.save_state().unwrap();
        let first_cpu = cpu.save_state().unwrap();
        thread::sleep(Duration::from_millis(50));
        let second_vm = vm.save_state().unwrap();
        let second_cpu = cpu.save_state().unwrap();

        assert_eq!(first_cpu.tsc_khz, second_cpu.tsc_khz);
        let clock_elapsed_ns = second_vm.clock.clock.wrapping_sub(first_vm.clock.clock);
        assert!(clock_elapsed_ns >= 50_000_000);
        let tsc_elapsed_ns = u128::from(saved_tsc(&second_cpu).wrapping_sub(saved_tsc(&first_cpu)))
            * 1_000_000
            / u128::from(second_cpu.tsc_khz);
        assert!(
            tsc_elapsed_ns.abs_diff(u128::from(clock_elapsed_ns)) <= 15_000_000,
            "guest TSC elapsed {tsc_elapsed_ns} ns, kvmclock elapsed {clock_elapsed_ns} ns"
        );
    }

    #[test]
    #[ignore = "requires Linux x86_64 with KVM TSC offset controls"]
    fn paused_snapshot_requires_vm_save_for_each_vcpu_capture_round() {
        let vm = &KvmVm::new().unwrap();
        thread::scope(|scope| {
            let (ready, wait_for_ready) = mpsc::channel();
            let (capture, wait_for_capture) = mpsc::channel();
            let (saved, receive_state) = mpsc::channel();
            scope.spawn(move || {
                let mut cpu = vm.create_vcpu(1).unwrap();
                cpu.set_cpu_features(&snapshot_cpuid(vm), &[]).unwrap();
                cpu.has_tsc_offset().unwrap();
                ready.send(cpu.get_tsc_offset().unwrap()).unwrap();
                for () in wait_for_capture {
                    saved.send(cpu.save_state().unwrap()).unwrap();
                }
            });
            let mut first = vm.create_vcpu(0).unwrap();
            first.set_cpu_features(&snapshot_cpuid(vm), &[]).unwrap();
            let second_offset = wait_for_ready.recv().unwrap();
            assert_vcpu_save_error(
                first.save_state().unwrap_err(),
                "save VM state before saving vCPU state",
            );
            first.has_tsc_offset().unwrap();
            let (Some(first_offset), Some(second_offset)) =
                (first.get_tsc_offset().unwrap(), second_offset)
            else {
                eprintln!(
                    "skipping clock correlation test: KVM does not expose TSC offset controls"
                );
                return;
            };

            let capture_round = |first: &mut KvmVcpu| {
                let first_cpu = first.save_state().unwrap();
                capture.send(()).unwrap();
                let second_cpu = receive_state.recv().unwrap();
                assert_eq!(first_cpu.tsc_khz, second_cpu.tsc_khz);
                let scaled_tsc = saved_tsc(&first_cpu).wrapping_sub(first_offset);
                assert_eq!(
                    scaled_tsc,
                    saved_tsc(&second_cpu).wrapping_sub(second_offset)
                );
                (first_cpu.tsc_khz, scaled_tsc)
            };

            let first_vm = vm.save_state().unwrap();
            let (first_khz, first_tsc) = capture_round(&mut first);
            thread::sleep(Duration::from_millis(50));
            assert_vcpu_save_error(
                first.save_state().unwrap_err(),
                "save VM state before recapturing vCPU state",
            );

            let second_vm = vm.save_state().unwrap();
            thread::sleep(Duration::from_millis(50));
            let (second_khz, second_tsc) = capture_round(&mut first);
            assert_eq!(first_khz, second_khz);
            let elapsed_ns =
                u128::from(second_tsc.wrapping_sub(first_tsc)) * 1_000_000 / u128::from(first_khz);
            let clock_elapsed_ns = second_vm.clock.clock.wrapping_sub(first_vm.clock.clock);
            assert!(clock_elapsed_ns >= 50_000_000);
            assert!(
                elapsed_ns.abs_diff(u128::from(clock_elapsed_ns)) <= 15_000_000,
                "guest TSC elapsed {elapsed_ns} ns, kvmclock elapsed {clock_elapsed_ns} ns"
            );
        });
    }

    #[test]
    #[ignore = "requires Linux x86_64 with KVM TSC offset controls"]
    fn vm_first_restore_keeps_guest_tsc_correlated_with_kvmclock() {
        let vm = KvmVm::new().unwrap();
        let mut cpu = vm.create_vcpu(0).unwrap();
        cpu.set_cpu_features(&snapshot_cpuid(&vm), &[]).unwrap();
        if !cpu.has_tsc_offset().unwrap() {
            eprintln!("skipping clock correlation test: KVM does not expose TSC offset controls");
            return;
        }
        let platform = vm.save_state().unwrap();
        thread::sleep(Duration::from_millis(50));
        let state = cpu.save_state().unwrap();
        let saved_tsc = saved_tsc(&state);
        let check_correlation = |phase, vm: &KvmVm, cpu: &KvmVcpu| {
            let before = vm.fd.get_clock().unwrap().clock;
            let guest_tsc = snapshot_msrs(&cpu.fd, &[MSR_IA32_TSC]).unwrap()[0].data;
            let after = vm.fd.get_clock().unwrap().clock;

            let elapsed_ns = u128::from(guest_tsc.wrapping_sub(saved_tsc)) * 1_000_000
                / u128::from(state.tsc_khz);
            let min_ns = before.wrapping_sub(platform.clock.clock);
            let max_ns = after.wrapping_sub(platform.clock.clock);
            assert!(min_ns >= 50_000_000);
            // Allow for scheduling delays in the save and restore samples.
            let tolerance_ns = 15_000_000;
            assert!(
                (u128::from(min_ns.saturating_sub(tolerance_ns))
                    ..=u128::from(max_ns + tolerance_ns))
                    .contains(&elapsed_ns),
                "{phase}: guest TSC elapsed {elapsed_ns} ns, kvmclock elapsed {min_ns}..={max_ns} ns"
            );
        };
        check_correlation("save", &vm, &cpu);
        drop(cpu);

        let vm = KvmVm::new().unwrap();
        vm.restore_before_vcpus(&platform).unwrap();
        thread::sleep(Duration::from_millis(50));
        let mut cpu = vm.create_vcpu(0).unwrap();
        cpu.restore_state(&state).unwrap();
        check_correlation("restore", &vm, &cpu);
    }

    #[test]
    #[ignore = "requires Linux x86_64 with KVM TSC deadline timers"]
    fn snapshot_restore_delivers_armed_tsc_deadline_after_tsc_restore() {
        const VECTOR: u8 = 0x51;
        const TSC_DEADLINE: u32 = 1 << 24;
        let ram = Ram::new();
        let vm = KvmVm::new().unwrap();
        let mut cpuid = snapshot_cpuid(&vm);
        let leaf = cpuid.iter_mut().find(|entry| entry.leaf == 1).unwrap();
        if leaf.ecx & TSC_DEADLINE == 0 {
            let capability = Kvm::new()
                .unwrap()
                .check_extension_int(Cap::TscDeadlineTimer);
            if capability == 0 {
                eprintln!("skipping LAPIC snapshot test: KVM does not expose TSC deadline timers");
                return;
            }
            assert!(
                capability > 0,
                "KVM_CHECK_EXTENSION(KVM_CAP_TSC_DEADLINE_TIMER) failed: {}",
                io::Error::last_os_error()
            );
            // KVM can expose the in-kernel timer through the capability alone.
            leaf.ecx |= TSC_DEADLINE;
        }
        // SAFETY: the guest program, ISR and real-mode vector fit in private RAM.
        unsafe {
            let page = std::slice::from_raw_parts_mut(ram.0.as_ptr(), 4096);
            page[..2].copy_from_slice(&[0xeb, 0xfe]); // JMP $.
            page[0x100..0x105].copy_from_slice(&[0xb0, VECTOR, 0xe6, 0x80, 0xf4]);
            let gate = 0x800 + usize::from(VECTOR) * 4;
            page[gate..gate + 4].copy_from_slice(&0x1100u32.to_le_bytes());
        }
        let mut cpu = vm.create_vcpu(0).unwrap();
        let khz = u64::from(cpu.fd.get_tsc_khz().unwrap());
        cpu.set_cpu_features(
            &cpuid,
            &[X86Msr {
                index: MSR_IA32_TSC,
                value: khz * 30_000,
            }],
        )
        .unwrap();
        let mut sregs = cpu.fd.get_sregs().unwrap();
        sregs.cs.base = 0;
        sregs.cs.selector = 0;
        sregs.idt.base = 0x1800;
        sregs.idt.limit = 0x3ff;
        cpu.fd.set_sregs(&sregs).unwrap();
        cpu.fd
            .set_regs(&kvm_regs {
                rip: 0x1000,
                rsp: 0x1ff0,
                rflags: 0x202,
                ..Default::default()
            })
            .unwrap();
        let mut lapic = cpu.fd.get_lapic().unwrap();
        lapic.regs[0xf1] |= 1; // Software enable in the spurious vector register.
        let lvtt = u32::from(VECTOR) | (2 << 17);
        lapic.regs[0x320..0x324].copy_from_slice(&lvtt.to_le_bytes().map(|byte| byte as i8));
        cpu.fd.set_lapic(&lapic).unwrap();
        let current = snapshot_msrs(&cpu.fd, &[MSR_IA32_TSC]).unwrap()[0].data;
        let deadline = current.wrapping_add(khz * 250);
        let msr = Msrs::from_entries(&[kvm_msr_entry {
            index: MSR_IA32_TSC_DEADLINE,
            data: deadline,
            ..Default::default()
        }])
        .unwrap();
        assert_eq!(cpu.fd.set_msrs(&msr).unwrap(), 1);
        let platform = vm.save_state().unwrap();
        let mut state = cpu.save_state().unwrap();
        drop(cpu);
        let deadline_index = state
            .msrs
            .iter()
            .position(|entry| entry.index == MSR_IA32_TSC_DEADLINE)
            .unwrap();
        let armed = state.msrs.remove(deadline_index);
        assert_eq!(armed.data, deadline);
        let tsc_index = state
            .msrs
            .iter()
            .position(|entry| entry.index == MSR_IA32_TSC)
            .unwrap();
        state.msrs.insert(tsc_index, armed);
        let irr = 0x200 + usize::from(VECTOR / 32) * 16 + usize::from((VECTOR % 32) / 8);
        assert_eq!(state.lapic.regs[irr] & (1 << (VECTOR % 8)), 0);

        let destination = KvmVm::new().unwrap();
        // SAFETY: RAM outlives the destination VM and vCPU.
        unsafe { destination.map_memory(&ram.region()) }.unwrap();
        destination.restore_before_vcpus(&platform).unwrap();
        let mut cpu = destination.create_vcpu(0).unwrap();
        cpu.restore_state(&state).unwrap();
        destination.restore_after_vcpus(&platform).unwrap();
        let kick = cpu.handle();
        let exit = thread::scope(|scope| {
            let (done, finished) = mpsc::channel::<()>();
            scope.spawn(move || {
                if let Err(mpsc::RecvTimeoutError::Timeout) =
                    finished.recv_timeout(Duration::from_secs(2))
                {
                    kick.kick().unwrap();
                }
            });
            let exit = cpu.run();
            drop(done);
            exit
        });
        match exit.unwrap() {
            VcpuExit::IoOut { port: 0x80, bytes } => assert_eq!(bytes, &[VECTOR]),
            exit => panic!("expected LAPIC deadline interrupt, got {exit:?}"),
        }
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn notify_guest_stopped_succeeds_for_inactive_and_active_pvclock() {
        const MSR_KVM_SYSTEM_TIME_NEW: u32 = 0x4b56_4d01;
        let ram = Ram::new();
        let source = KvmVm::new().unwrap();
        // SAFETY: the page outlives the VMs and vCPUs, which use it in sequence.
        unsafe { source.map_memory(&ram.region()) }.unwrap();
        let mut cpu = source.create_vcpu(0).unwrap();
        cpu.notify_guest_stopped().unwrap();
        let active = ram.region().guest_addr | 1;
        cpu.set_cpu_features(
            &snapshot_cpuid(&source),
            &[X86Msr {
                index: MSR_KVM_SYSTEM_TIME_NEW,
                value: active,
            }],
        )
        .unwrap();
        cpu.fd.kvmclock_ctrl().unwrap();
        cpu.notify_guest_stopped().unwrap();
        let platform = source.save_state().unwrap();
        let state = cpu.save_state().unwrap();
        drop(cpu);
        drop(source);

        let destination = KvmVm::new().unwrap();
        // SAFETY: the source VM has released the page and it outlives the destination.
        unsafe { destination.map_memory(&ram.region()) }.unwrap();
        destination.restore_before_vcpus(&platform).unwrap();
        let mut cpu = destination.create_vcpu(0).unwrap();
        cpu.restore_state(&state).unwrap();
        destination.restore_after_vcpus(&platform).unwrap();
        cpu.fd.kvmclock_ctrl().unwrap();
        cpu.notify_guest_stopped().unwrap();
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn wall_clock_restore_preserves_epoch_across_vcpus() {
        use crate::X86Msr;
        use crate::kvm::vcpu::MSR_KVM_WALL_CLOCK_NEW;

        let source_ram = Ram::new();
        let source = KvmVm::new().unwrap();
        let region = source_ram.region();
        // SAFETY: source RAM outlives the VM and its vCPUs.
        unsafe { source.map_memory(&region) }.unwrap();
        let offset = 7 * 24 * 60 * 60 * 1_000_000_000;
        source
            .fd
            .set_clock(&kvm_clock_data {
                clock: offset,
                ..Default::default()
            })
            .unwrap();
        let configure = |id| {
            let mut cpu = source.create_vcpu(id).unwrap();
            cpu.set_cpu_features(
                &snapshot_cpuid(&source),
                &[X86Msr {
                    index: MSR_KVM_WALL_CLOCK_NEW,
                    value: region.guest_addr,
                }],
            )
            .unwrap();
            cpu
        };
        let (platform, cpus) = thread::scope(|scope| {
            let (start, wait_for_start) = mpsc::channel();
            let (ready, wait_for_ready) = mpsc::channel();
            let (capture, wait_for_capture) = mpsc::channel();
            let second = scope.spawn(move || {
                wait_for_start.recv().unwrap();
                let mut cpu = configure(1);
                ready.send(()).unwrap();
                wait_for_capture.recv().unwrap();
                cpu.save_state().unwrap()
            });
            let mut first = configure(0);
            start.send(()).unwrap();
            wait_for_ready.recv().unwrap();
            let platform = source.save_state().unwrap();
            capture.send(()).unwrap();
            (
                platform,
                [first.save_state().unwrap(), second.join().unwrap()],
            )
        });
        for state in &cpus {
            assert!(state.msrs.iter().any(|entry| {
                entry.index == MSR_KVM_WALL_CLOCK_NEW && entry.data == region.guest_addr
            }));
        }
        assert!(platform.clock.clock >= offset);

        let read_wall_clock = |ram: &Ram| -> [u32; 3] {
            // SAFETY: all restore ioctls have finished and no vCPU entered KVM_RUN.
            let bytes = unsafe { std::slice::from_raw_parts(ram.0.as_ptr(), 12) };
            std::array::from_fn(|i| u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap()))
        };
        let expected_version = {
            let ram = Ram::new();
            let vm = KvmVm::new().unwrap();
            // SAFETY: destination RAM outlives the VM and both vCPUs.
            unsafe { vm.map_memory(&ram.region()) }.unwrap();
            vm.restore_before_vcpus(&platform).unwrap();
            for (id, state) in (0..).zip(&cpus) {
                vm.create_vcpu(id).unwrap().restore_state(state).unwrap();
            }
            vm.restore_after_vcpus(&platform).unwrap();
            read_wall_clock(&ram)[0]
        };
        // Each vCPU's wall-clock write advances the version by two.
        assert!(
            expected_version >= 4 && expected_version.is_multiple_of(2),
            "serial pvclock version {expected_version}"
        );

        let ram = Ram::new();
        let vm = KvmVm::new().unwrap();
        // SAFETY: destination RAM outlives the VM and both worker threads.
        unsafe { vm.map_memory(&ram.region()) }.unwrap();
        let before = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        vm.restore_before_vcpus(&platform).unwrap();
        let after = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        let start_restore = Barrier::new(cpus.len());
        thread::scope(|scope| {
            for (id, state) in (0..).zip(&cpus) {
                let (vm, start_restore) = (&vm, &start_restore);
                scope.spawn(move || {
                    let vcpu = vm.create_vcpu(id);
                    start_restore.wait();
                    vcpu.unwrap().restore_state(state).unwrap();
                });
            }
        });
        vm.restore_after_vcpus(&platform).unwrap();

        let [version, sec, nsec] = read_wall_clock(&ram);
        assert_eq!(version, expected_version);
        let epoch = Duration::new(u64::from(sec), nsec);
        let restored_realtime = epoch + Duration::from_nanos(platform.clock.clock);
        let tolerance = Duration::from_secs(2);
        let realtime_window = before.saturating_sub(tolerance)..=after + tolerance;
        assert!(
            realtime_window.contains(&restored_realtime),
            "pvclock epoch plus saved clock {restored_realtime:?}, host realtime window {realtime_window:?}"
        );
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn pending_ioapic_level_irq_and_pit_deliver_after_vcpu_restore() {
        use crate::{X86BootRegisters, X86IrqchipState, X86Segment};

        const PIN: usize = 5;
        const VECTOR: u8 = 0x51;
        const REMOTE_IRR: u64 = 1 << 14;
        const LEVEL_TRIGGERED: u64 = 1 << 15;
        const IDT: usize = 0x1800;
        const GDT: usize = 0x1700;
        const ENTRY: usize = 0x1000;
        const HANDLER: usize = 0x1100;

        // Report zero if no interrupt reaches the vCPU before its first instruction.
        let entry = [0x31, 0xc0, 0xe6, 0x80, 0xf4]; // XOR EAX,EAX; OUT 0x80,AL; HLT.
        #[rustfmt::skip]
        let handler = [
            0xb0, VECTOR, 0xe6, 0x80, // MOV AL,VECTOR; OUT 0x80,AL.
            // MOV dword [0xfee000b0],0 (xAPIC EOI).
            0xc7, 0x05, 0xb0, 0x00, 0xe0, 0xfe, 0x00, 0x00, 0x00, 0x00,
            0xe6, 0x81, 0xf4, // OUT 0x81,AL; HLT.
        ];
        // 32-bit interrupt gate to HANDLER in code segment 8.
        let gate = (HANDLER as u64 | (8 << 16) | (0x8e << 40)).to_le_bytes();
        let ram = Ram::new();
        // SAFETY: RAM is private and unmapped, and all the fixtures fit in the page.
        unsafe {
            let page = std::slice::from_raw_parts_mut(ram.0.as_ptr(), 4096);
            page[..entry.len()].copy_from_slice(&entry);
            let handler_offset = HANDLER - ENTRY;
            page[handler_offset..handler_offset + handler.len()].copy_from_slice(&handler);
            let gdt_offset = GDT - ENTRY;
            page[gdt_offset + 8..gdt_offset + 16]
                .copy_from_slice(&0x00cf_9b00_0000_ffffu64.to_le_bytes());
            page[gdt_offset + 16..gdt_offset + 24]
                .copy_from_slice(&0x00cf_9300_0000_ffffu64.to_le_bytes());
            let gate_offset = IDT - ENTRY + usize::from(VECTOR) * 8;
            page[gate_offset..gate_offset + 8].copy_from_slice(&gate);
        }

        let read_ioapic = |vm: &KvmVm| {
            let mut chip = kvm_irqchip {
                chip_id: KVM_IRQCHIP_IOAPIC,
                ..Default::default()
            };
            vm.fd.get_irqchip(&mut chip).unwrap();
            // SAFETY: the chip ID selects the initialized IOAPIC member.
            unsafe { chip.chip.ioapic }
        };
        let source = KvmVm::new().unwrap();
        // SAFETY: RAM outlives both VMs, and only the destination enters the guest.
        unsafe { source.map_memory(&ram.region()) }.unwrap();
        let mut cpu = source.create_vcpu(0).unwrap();
        cpu.set_cpu_features(&snapshot_cpuid(&source), &[]).unwrap();
        cpu.set_boot_registers(&X86BootRegisters {
            rip: ENTRY as u64,
            rsp: (ENTRY + 4096) as u64,
            rflags: 0x202, // IF and the reserved bit.
            cr0: 0x11,     // Protected mode with paging disabled.
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
            gdt_base: GDT as u64,
            gdt_limit: 23,
            idt_base: IDT as u64,
            idt_limit: u16::from(VECTOR) * 8 + 7,
            ..Default::default()
        })
        .unwrap();
        for id in [KVM_IRQCHIP_PIC_MASTER, KVM_IRQCHIP_PIC_SLAVE] {
            let pic = X86IrqchipState::pic(
                id,
                kvm_bindings::kvm_pic_state {
                    imr: u8::MAX,
                    ..Default::default()
                },
            );
            source.fd.set_irqchip(pic.as_kvm()).unwrap();
        }
        let mut ioapic = read_ioapic(&source);
        ioapic.redirtbl[PIN].bits = u64::from(VECTOR) | LEVEL_TRIGGERED;
        source
            .fd
            .set_irqchip(X86IrqchipState::ioapic(ioapic).as_kvm())
            .unwrap();
        // Hold the line high while the LAPIC is still software-disabled, so the
        // IOAPIC has a pending level without an outstanding LAPIC delivery.
        let mut lapic = cpu.fd.get_lapic().unwrap();
        lapic.regs[0xf1] &= !1;
        cpu.fd.set_lapic(&lapic).unwrap();
        source.set_irq_line(PIN as u32, true).unwrap();
        lapic.regs[0xf1] |= 1; // Enable the LAPIC via the spurious interrupt register.
        cpu.fd.set_lapic(&lapic).unwrap();

        let mut pit = source.fd.get_pit2().unwrap();
        let channel = &mut pit.channels[0];
        channel.count = 0x3456;
        channel.mode = 2; // Periodic rate generator, with IRQ0 masked above.
        channel.rw_mode = 3;
        channel.gate = 1;
        source.fd.set_pit2(&pit).unwrap();
        let platform = source.save_state().unwrap();
        // SAFETY: the third chip contains the initialized IOAPIC image.
        let pending = unsafe { platform.irqchips[2].as_kvm().chip.ioapic };
        assert_ne!(pending.irr & (1 << PIN), 0);
        // SAFETY: the snapshot contains an initialized IOAPIC redirection table.
        assert_eq!(unsafe { pending.redirtbl[PIN].bits } & REMOTE_IRR, 0);
        let state = cpu.save_state().unwrap();
        drop(cpu);
        drop(source);

        let vm = KvmVm::new().unwrap();
        // SAFETY: source VM is gone, and RAM outlives the destination VM and vCPU.
        unsafe { vm.map_memory(&ram.region()) }.unwrap();
        vm.restore_before_vcpus(&platform).unwrap();
        let mut cpu = vm.create_vcpu(0).unwrap();
        cpu.restore_state(&state).unwrap();
        vm.restore_after_vcpus(&platform).unwrap();
        match cpu.run().unwrap() {
            VcpuExit::IoOut { port: 0x80, bytes } => assert_eq!(bytes, &[VECTOR]),
            exit => panic!("expected IOAPIC interrupt handler output, got {exit:?}"),
        }
        // SAFETY: GET_IRQCHIP initialized the redirection entries as raw bits.
        assert_ne!(
            unsafe { read_ioapic(&vm).redirtbl[PIN].bits } & REMOTE_IRR,
            0
        );
        vm.set_irq_line(PIN as u32, false).unwrap();
        match cpu.run().unwrap() {
            VcpuExit::IoOut { port: 0x81, bytes } => assert_eq!(bytes, &[VECTOR]),
            exit => panic!("expected output after LAPIC EOI, got {exit:?}"),
        }
        cpu.complete_pending_io().unwrap();
        // SAFETY: GET_IRQCHIP initialized the redirection entries as raw bits.
        assert_eq!(
            unsafe { read_ioapic(&vm).redirtbl[PIN].bits } & REMOTE_IRR,
            0
        );
        let saved_pit = platform.pit.unwrap().channels[0];
        let restored_pit = vm.fd.get_pit2().unwrap().channels[0];
        assert_eq!(restored_pit.count, saved_pit.count);
        assert_eq!(restored_pit.mode, saved_pit.mode);
        assert_eq!(restored_pit.rw_mode, saved_pit.rw_mode);
        assert_eq!(restored_pit.gate, saved_pit.gate);
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn vm_snapshot_without_pit_leaves_destination_pit_untouched() {
        let source = KvmVm::new().unwrap();
        let mut state = source.save_state().unwrap();
        state.pit = None;
        let destination = KvmVm::new().unwrap();
        let mut pit = destination.fd.get_pit2().unwrap();
        pit.channels[2].count = 0x7654;
        pit.channels[2].mode = 3;
        destination.fd.set_pit2(&pit).unwrap();
        destination.restore_before_vcpus(&state).unwrap();
        destination.restore_after_vcpus(&state).unwrap();
        let actual = destination.fd.get_pit2().unwrap();
        assert_eq!(actual.channels[2].count, pit.channels[2].count);
        assert_eq!(actual.channels[2].mode, pit.channels[2].mode);
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
        crate::X86Vm::restore_before_vcpus(&destination, &state).unwrap();
        crate::X86Vm::restore_after_vcpus(&destination, &state).unwrap();
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
        destination.restore_before_vcpus(&state).unwrap();
        destination.restore_after_vcpus(&state).unwrap();
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
        snapshot_run_sse_and_msrs(false);
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_restore_preserves_xsave_when_fpu_image_diverges() {
        snapshot_run_sse_and_msrs(true);
    }

    fn snapshot_run_sse_and_msrs(diverging_fpu: bool) {
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
        source.set_cpu_features(&snapshot_cpuid(&vm), &[]).unwrap();
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
        assert_vcpu_save_error(
            source.save_state().unwrap_err(),
            "complete pending I/O before saving",
        );
        source.complete_pending_io().unwrap();
        let platform = vm.save_state().unwrap();
        let mut state = crate::X86Vcpu::save_state(&mut source).unwrap();
        assert_eq!(state.regs.rip, 0x104c);
        assert_eq!(state.fpu.xmm[0], xmm);
        if diverging_fpu {
            // The standard XSAVE layout starts XMM0 at byte 160.
            let saved_xmm: Vec<_> = state.xsave[40..44]
                .iter()
                .flat_map(|word| word.to_le_bytes())
                .collect();
            assert_eq!(saved_xmm, xmm);
            state.fpu.xmm[0] = xmm.map(|byte| !byte);
        }
        drop(source);
        drop(vm);

        let destination_vm = KvmVm::new().unwrap();
        // SAFETY: same lifetime/serialization contract as the source mapping.
        unsafe { destination_vm.map_memory(&ram.region()) }.unwrap();
        destination_vm.restore_before_vcpus(&platform).unwrap();
        let mut destination = destination_vm.create_vcpu(0).unwrap();
        crate::X86Vcpu::restore_state(&mut destination, &state).unwrap();
        destination_vm.restore_after_vcpus(&platform).unwrap();
        assert_eq!(destination.fd.get_regs().unwrap(), state.regs);
        if !diverging_fpu {
            assert_eq!(destination.fd.get_fpu().unwrap(), state.fpu);
        }
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
    #[ignore = "requires /dev/kvm"]
    fn snapshot_restores_ap_at_pending_sipi_vector() {
        use crate::{X86BootRegisters, X86Segment};
        use kvm_bindings::{KVM_MP_STATE_INIT_RECEIVED, KVM_MP_STATE_RUNNABLE, kvm_mp_state};

        const SIPI_VECTOR: u8 = 0x02;
        const SIPI_ENTRY: u64 = (SIPI_VECTOR as u64) << 12;
        const STALE_ENTRY: u64 = 0x1000;
        const BSP_ENTRY: u64 = 0x1100;

        let ram = Ram::new();
        let sipi_ram = Ram::new();
        let sipi_region = MemoryRegion {
            guest_addr: SIPI_ENTRY,
            ..sipi_ram.region()
        };
        // Real mode: MOV AL, byte; OUT 0x80, AL; HLT.
        let stale_code = [0xb0, b'X', 0xe6, 0x80, 0xf4];
        let sipi_code = [0xb0, b'S', 0xe6, 0x80, 0xf4];
        // Flat 32-bit mode: write the xAPIC registers, then signal completion.
        #[rustfmt::skip]
        let bsp_code = [
            // MOV dword [0xfee000f0], 0x1ff (enable the LAPIC).
            0xc7, 0x05, 0xf0, 0x00, 0xe0, 0xfe, 0xff, 0x01, 0x00, 0x00,
            // MOV dword [0xfee00310], 0x01000000 (ICR high, APIC ID 1).
            0xc7, 0x05, 0x10, 0x03, 0xe0, 0xfe, 0x00, 0x00, 0x00, 0x01,
            // MOV dword [0xfee00300], 0x4602 (ICR low, assert SIPI).
            0xc7, 0x05, 0x00, 0x03, 0xe0, 0xfe, SIPI_VECTOR, 0x46, 0x00, 0x00,
            0xe6, 0x81, 0xf4, // OUT 0x81, AL; HLT.
        ];
        // SAFETY: both pages are private and unmapped from the guest, and each
        // program fits at its offset without overlapping another program.
        unsafe {
            std::ptr::copy_nonoverlapping(stale_code.as_ptr(), ram.0.as_ptr(), stale_code.len());
            std::ptr::copy_nonoverlapping(
                bsp_code.as_ptr(),
                ram.0.as_ptr().add((BSP_ENTRY - STALE_ENTRY) as usize),
                bsp_code.len(),
            );
            std::ptr::copy_nonoverlapping(sipi_code.as_ptr(), sipi_ram.0.as_ptr(), sipi_code.len());
        }
        let vm = KvmVm::new().unwrap();
        // SAFETY: both pages outlive the VM and all vCPUs.
        unsafe {
            vm.map_memory(&ram.region()).unwrap();
            vm.map_memory(&sipi_region).unwrap();
        }
        let (platform, state) = thread::scope(|scope| {
            let vm = &vm;
            let (ap_ready, wait_for_ap) = mpsc::channel();
            // Spawn before creating the AP so the BSP worker inherits an
            // unblocked kick signal that it can reserve for itself.
            let bsp = scope.spawn(move || {
                let mut bsp = vm.create_vcpu(0).unwrap();
                bsp.set_cpu_features(&snapshot_cpuid(vm), &[]).unwrap();
                bsp.set_boot_registers(&X86BootRegisters {
                    rip: BSP_ENTRY,
                    rflags: 2,
                    cr0: 0x11, // Protected mode, ET, paging disabled.
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
                wait_for_ap.recv().unwrap();
                assert!(matches!(
                    bsp.run().unwrap(),
                    VcpuExit::IoOut { port: 0x81, .. }
                ));
                bsp.complete_pending_io().unwrap();
            });

            let mut ap = vm.create_vcpu(1).unwrap();
            ap.set_cpu_features(&snapshot_cpuid(vm), &[]).unwrap();
            let mut segments = ap.fd.get_sregs().unwrap();
            segments.cs.selector = 0;
            segments.cs.base = 0;
            ap.fd.set_sregs(&segments).unwrap();
            ap.fd
                .set_regs(&kvm_regs {
                    rip: STALE_ENTRY,
                    rflags: 2,
                    ..Default::default()
                })
                .unwrap();
            ap.fd
                .set_mp_state(kvm_mp_state {
                    mp_state: KVM_MP_STATE_INIT_RECEIVED,
                })
                .unwrap();

            // The BSP queues the SIPI while the AP stays out of KVM_RUN.
            ap_ready.send(()).unwrap();
            bsp.join().unwrap();
            (vm.save_state().unwrap(), ap.save_state().unwrap())
        });

        assert_eq!(state.mp_state.mp_state, KVM_MP_STATE_RUNNABLE);
        assert_eq!(state.sregs.cs.selector, u16::from(SIPI_VECTOR) << 8);
        assert_eq!(state.sregs.cs.base, SIPI_ENTRY);
        assert_eq!(state.regs.rip, 0);
        drop(vm);

        let destination = KvmVm::new().unwrap();
        // SAFETY: the source VM is gone, and both pages outlive the destination.
        unsafe {
            destination.map_memory(&ram.region()).unwrap();
            destination.map_memory(&sipi_region).unwrap();
        }
        destination.restore_before_vcpus(&platform).unwrap();
        let mut ap_dst = destination.create_vcpu(1).unwrap();
        ap_dst.restore_state(&state).unwrap();
        destination.restore_after_vcpus(&platform).unwrap();
        let exit = thread::scope(|scope| {
            let kick = ap_dst.handle();
            let (finished, done) = mpsc::channel::<()>();
            scope.spawn(move || {
                let timeout = Duration::from_secs(5);
                if let Err(mpsc::RecvTimeoutError::Timeout) = done.recv_timeout(timeout) {
                    kick.kick().unwrap();
                }
            });
            let exit = ap_dst.run();
            drop(finished);
            exit
        });
        match exit.unwrap() {
            VcpuExit::IoOut { port: 0x80, bytes } => assert_eq!(bytes, b"S"),
            exit => panic!("expected AP output at the SIPI vector, got {exit:?}"),
        }
        ap_dst.complete_pending_io().unwrap();
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
        if leaf1.ecx & (1 << 28) == 0 {
            eprintln!("skipping YMM snapshot test: KVM does not expose AVX");
            return;
        }
        // SAFETY: RAM outlives both VMs; only one CPU executes at a time.
        unsafe { vm.map_memory(&ram.region()) }.unwrap();
        let mut source = vm.create_vcpu(0).unwrap();
        source.set_cpu_features(&snapshot_cpuid(&vm), &[]).unwrap();
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
        let platform = vm.save_state().unwrap();
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
        vm.restore_before_vcpus(&platform).unwrap();
        let mut destination = vm.create_vcpu(0).unwrap();
        destination.restore_state(&state).unwrap();
        vm.restore_after_vcpus(&platform).unwrap();
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
