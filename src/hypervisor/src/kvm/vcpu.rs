// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{io, marker::PhantomData, rc::Rc, sync::Arc};

use kvm_bindings::{
    KVM_EXIT_HLT, KVM_EXIT_INTR, KVM_EXIT_IO, KVM_EXIT_IO_IN, KVM_EXIT_IO_OUT, KVM_EXIT_MMIO,
    KVM_EXIT_SHUTDOWN, KVM_EXIT_SYSTEM_EVENT, KVM_SYSTEM_EVENT_RESET, KVM_SYSTEM_EVENT_SHUTDOWN,
    kvm_run,
};
use kvm_ioctls::VcpuFd;

use super::{KvmVcpuHandle, kick::WorkerSignal};
use crate::{Error, Result, VcpuExit};

/// Number of u32 words in kvm_xsave.region, before its flexible-array tail.
const XSAVE_REGION_WORDS: usize = 1024;

/// KVM_SET_MSRS returns E2BIG when nmsrs >= KVM_MAX_MSR_ENTRIES;
/// each ioctl can write at most 255 entries.
const MAX_MSR_BATCH_ENTRIES: usize = kvm_bindings::KVM_MAX_MSR_ENTRIES - 1;

/// A Linux x86_64 vCPU bound to its creating thread.
///
/// Creation leaves KVM's reset register state intact and reserves the kick
/// signal on this worker until drop. The caller supplies entry registers.
#[derive(Debug)]
pub struct KvmVcpu {
    pub(super) fd: VcpuFd,
    pub(super) id: u32,
    run_size: usize,
    pending_io: PendingIo,
    entered: bool,
    xsave_size: usize,
    msr_indices: Arc<[u32]>,
    kick: WorkerSignal,
    _thread_bound: PhantomData<Rc<()>>,
}

impl KvmVcpu {
    pub(super) fn new(
        fd: VcpuFd,
        id: u32,
        run_size: usize,
        kick: WorkerSignal,
        xsave_size: usize,
        msr_indices: Arc<[u32]>,
    ) -> Self {
        Self {
            fd,
            id,
            run_size,
            pending_io: PendingIo::default(),
            entered: false,
            xsave_size,
            msr_indices,
            kick,
            _thread_bound: PhantomData,
        }
    }

    /// Returns a handle that interrupts this worker, including before entry.
    pub fn handle(&self) -> KvmVcpuHandle {
        self.kick.handle()
    }

    /// Runs until the next exit; handle borrowed device bytes before re-entry.
    /// An idle guest blocks until an interrupt or a cross-thread kick arrives.
    pub fn run(&mut self) -> Result<VcpuExit<'_>> {
        self.entered = true;
        match self.fd.run().map(|_| ()) {
            Ok(()) => {}
            // A vCPU waiting for INIT or SIPI returns this once it accepts one.
            Err(error) if error.errno() == libc::EAGAIN => return Ok(VcpuExit::Interrupted),
            Err(error) if error.errno() == libc::EINTR => {
                self.kick.drain().map_err(|source| Error::RunVcpu {
                    id: self.id,
                    source,
                })?;
                self.pending_io.0 = false;
                return Ok(VcpuExit::Interrupted);
            }
            Err(error) => {
                return Err(Error::RunVcpu {
                    id: self.id,
                    source: error.into(),
                });
            }
        }
        // Reborrow after rust-vmm's exit: its port variants omit the count that
        // distinguishes a single access from a repeated string transfer.
        let run = self.fd.get_kvm_run();
        self.pending_io.0 = matches!(run.exit_reason, KVM_EXIT_IO | KVM_EXIT_MMIO);
        // SAFETY: the descriptor owns the complete run_size mapping, KVM_RUN
        // has returned, and &mut self excludes both re-entry and other users.
        unsafe { decode_exit(self.id, run, self.run_size) }
    }

    /// Finishes handled I/O without executing another guest instruction.
    /// A second completion is a no-op; failures retain the pending access.
    pub fn complete_pending_io(&mut self) -> Result<()> {
        self.pending_io
            .complete(|| {
                self.fd.set_kvm_immediate_exit(1);
                let result = self.fd.run().map(|_| ()).map_err(io::Error::from);
                self.fd.set_kvm_immediate_exit(0);
                result
            })
            .map_err(|source| Error::CompletePendingIo {
                id: self.id,
                source,
            })
    }
}

impl crate::Vcpu for KvmVcpu {
    type Handle = KvmVcpuHandle;

    fn run(&mut self) -> Result<VcpuExit<'_>> {
        Self::run(self)
    }

    fn complete_pending_io(&mut self) -> Result<()> {
        Self::complete_pending_io(self)
    }

    fn notify_guest_stopped(&mut self) -> Result<()> {
        crate::vcpu::kvmclock_ctrl_result(self.fd.kvmclock_ctrl().map_err(io::Error::from)).map_err(
            |source| Error::ConfigureVcpu {
                id: self.id,
                operation: "notify guest stopped",
                source,
            },
        )
    }

    fn handle(&self) -> Self::Handle {
        Self::handle(self)
    }
}

impl crate::X86Vcpu for KvmVcpu {
    fn save_state(&mut self) -> Result<crate::X86VcpuState> {
        Self::save_state(self)
    }

    fn restore_state(&mut self, state: &crate::X86VcpuState) -> Result<()> {
        Self::restore_state(self, state)
    }

    fn set_cpu_features(
        &mut self,
        cpuid: &[crate::X86CpuidEntry],
        msrs: &[crate::X86Msr],
    ) -> Result<()> {
        Self::set_cpu_features(self, cpuid, msrs)
    }

    fn set_boot_registers(&mut self, state: &crate::X86BootRegisters) -> Result<()> {
        Self::set_boot_registers(self, state)
    }
}

#[derive(Debug, Default)]
struct PendingIo(bool);

impl PendingIo {
    fn complete(&mut self, enter: impl FnOnce() -> io::Result<()>) -> io::Result<()> {
        if !self.0 {
            return Ok(());
        }
        match enter() {
            Err(error) if error.raw_os_error() == Some(libc::EINTR) => {
                self.0 = false;
                Ok(())
            }
            Err(error) => Err(error),
            Ok(()) => Err(io::Error::other(
                "KVM_RUN returned an exit during I/O completion",
            )),
        }
    }
}

// SAFETY: run must begin a live, exclusively borrowed mapping of run_size bytes.
// No vCPU may enter KVM while the returned exit borrows that mapping.
unsafe fn decode_exit(id: u32, run: &mut kvm_run, run_size: usize) -> Result<VcpuExit<'_>> {
    let reason = run.exit_reason;
    let unsupported = || Error::UnhandledExit {
        id,
        reason: format!("KVM exit {reason} has an unsupported reason or I/O shape"),
    };
    match reason {
        KVM_EXIT_IO => {
            // SAFETY: exit_reason identifies the active union field.
            let access = unsafe { run.__bindgen_anon_1.io };
            let offset = usize::try_from(access.data_offset).map_err(|_| unsupported())?;
            let size = usize::from(access.size);
            if access.count != 1
                || !matches!(size, 1 | 2 | 4)
                || offset < size_of::<kvm_run>()
                || offset.checked_add(size).is_none_or(|end| end > run_size)
                || !matches!(
                    u32::from(access.direction),
                    KVM_EXIT_IO_IN | KVM_EXIT_IO_OUT
                )
            {
                return Err(unsupported());
            }
            // SAFETY: the caller supplies the entire mapping; the checked range
            // lies beyond the header and inside it. The exit retains its borrow.
            let bytes = unsafe {
                std::slice::from_raw_parts_mut((run as *mut kvm_run).cast::<u8>().add(offset), size)
            };
            Ok(if u32::from(access.direction) == KVM_EXIT_IO_IN {
                VcpuExit::IoIn {
                    port: access.port,
                    bytes,
                }
            } else {
                VcpuExit::IoOut {
                    port: access.port,
                    bytes,
                }
            })
        }
        KVM_EXIT_MMIO => {
            // SAFETY: exit_reason identifies the active union field.
            let access = unsafe { &mut run.__bindgen_anon_1.mmio };
            if !matches!(access.len, 1 | 2 | 4 | 8) || access.is_write > 1 {
                return Err(unsupported());
            }
            let bytes = &mut access.data[..access.len as usize];
            Ok(if access.is_write == 0 {
                VcpuExit::MmioRead {
                    guest_addr: access.phys_addr,
                    bytes,
                }
            } else {
                VcpuExit::MmioWrite {
                    guest_addr: access.phys_addr,
                    bytes,
                }
            })
        }
        KVM_EXIT_INTR => Ok(VcpuExit::Interrupted),
        KVM_EXIT_HLT => Ok(VcpuExit::Halted),
        KVM_EXIT_SHUTDOWN => Ok(VcpuExit::Reset), // x86 triple fault.
        KVM_EXIT_SYSTEM_EVENT => {
            // SAFETY: exit_reason identifies the active union field.
            match unsafe { run.__bindgen_anon_1.system_event.type_ } {
                KVM_SYSTEM_EVENT_SHUTDOWN => Ok(VcpuExit::Shutdown),
                KVM_SYSTEM_EVENT_RESET => Ok(VcpuExit::Reset),
                _ => Err(unsupported()),
            }
        }
        _ => Err(unsupported()),
    }
}

impl KvmVcpu {
    /// Captures an architecture- and host-version-specific CPU image.
    /// Does not enter KVM_RUN, even to complete outstanding I/O: the caller must
    /// call `complete_pending_io` first, then stop all other VM state producers.
    ///
    /// Read `KVM_GET_MP_STATE` first so `kvm_apic_accept_events()` can apply
    /// pending INIT/SIPI events and update `CS:RIP` and related state. Then read
    /// `KVM_GET_VCPU_EVENTS` before `sregs` and `debug_regs` to capture any pending
    /// `#PF`/`#DB` payload materialized into `CR2`/`DR6`.
    pub fn save_state(&mut self) -> Result<crate::X86VcpuState> {
        let save = || -> io::Result<crate::X86VcpuState> {
            if self.pending_io.0 {
                return Err(io::Error::other("complete pending I/O before saving"));
            }
            let mp_state = self.fd.get_mp_state()?;
            let events = self.fd.get_vcpu_events()?;
            let sregs = self.fd.get_sregs()?;
            let mut xsave = self.xsave_buffer()?;
            if self.xsave_size == 0 {
                // SAFETY: this branch uses the fixed-size GET_XSAVE ioctl.
                unsafe { xsave.as_mut_fam_struct().xsave = self.fd.get_xsave()? };
            } else {
                // SAFETY: buffer covers the VM's KVM_CAP_XSAVE2 size. The API
                // contract forbids enabling dynamic XSTATE permissions later.
                unsafe { self.fd.get_xsave2(&mut xsave) }?;
            }
            let mut words = Vec::with_capacity(XSAVE_REGION_WORDS + xsave.as_slice().len());
            words.extend_from_slice(&xsave.as_fam_struct_ref().xsave.region);
            words.extend_from_slice(xsave.as_slice());
            Ok(crate::X86VcpuState {
                regs: self.fd.get_regs()?,
                sregs,
                fpu: self.fd.get_fpu()?,
                cpuid: self
                    .fd
                    .get_cpuid2(kvm_bindings::KVM_MAX_CPUID_ENTRIES)?
                    .as_slice()
                    .to_vec(),
                msrs: super::features::snapshot_msrs(&self.fd, &self.msr_indices)?,
                xsave: words,
                xcrs: self.fd.get_xcrs()?,
                debug_regs: self.fd.get_debug_regs()?,
                events,
                mp_state,
                lapic: self.fd.get_lapic()?,
                tsc_khz: self.fd.get_tsc_khz()?,
            })
        };
        save().map_err(|source| Error::ConfigureVcpu {
            id: self.id,
            operation: "save CPU state",
            source,
        })
    }

    /// Overwrites a fresh, never-entered vCPU; never executes guest code.
    /// This architecture-/host-version-specific operation is NOT transactional:
    /// discard the destination after any error.
    ///
    /// CPUID must precede CPUID-gated MSRs/XCRs.
    /// TSC scaling precedes TSC writes; SREGS precedes REGS and establishes mode
    /// and APIC base. LAPIC precedes MSRs so its timer setup cannot clobber the
    /// saved TSC deadline. MSRs (including XSS/XFD) precede XCRS/XSAVE. Dedicated
    /// SET_FPU follows XSAVE so the legacy x87/SSE image is authoritative.
    /// Debug/REGS follow mode setup, MP state and events are last (LAPIC/SREGS
    /// can change pending events). No VM-global clock/device state is touched.
    pub fn restore_state(&mut self, state: &crate::X86VcpuState) -> Result<()> {
        let mut restore = || -> io::Result<()> {
            let invalid = |message| io::Error::new(io::ErrorKind::InvalidInput, message);
            if self.entered || self.pending_io.0 {
                return Err(invalid("restore requires a fresh, never-entered vCPU"));
            }
            let cpuid = super::features::snapshot_cpuid(&state.cpuid)?;
            let mut xsave = self.xsave_buffer()?;
            if state.xsave.len() != XSAVE_REGION_WORDS + xsave.as_slice().len()
                || state.xcrs.nr_xcrs as usize > state.xcrs.xcrs.len()
            {
                return Err(invalid("invalid XSAVE/XCR snapshot shape"));
            }
            // SAFETY: the destination-sized buffer and length check above
            // guarantee matching slice lengths. Copying the fixed region does
            // not change the flexible-array length or its allocation.
            unsafe {
                xsave
                    .as_mut_fam_struct()
                    .xsave
                    .region
                    .copy_from_slice(&state.xsave[..XSAVE_REGION_WORDS])
            };
            xsave
                .as_mut_slice()
                .copy_from_slice(&state.xsave[XSAVE_REGION_WORDS..]);
            let current_khz = self.fd.get_tsc_khz()?;
            self.fd.set_cpuid2(&cpuid)?;
            if current_khz != state.tsc_khz {
                self.fd.set_tsc_khz(state.tsc_khz)?;
            }
            self.fd.set_sregs(&state.sregs)?;
            self.fd.set_lapic(&state.lapic)?;
            for chunk in state.msrs.chunks(MAX_MSR_BATCH_ENTRIES) {
                let msrs = kvm_bindings::Msrs::from_entries(chunk)
                    .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
                let written = self.fd.set_msrs(&msrs)?;
                super::features::check_written(&msrs, written)?;
            }
            self.fd.set_xcrs(&state.xcrs)?;
            // SAFETY: destination-sized allocation, checked above; no dynamic
            // XSTATE permission changes are allowed during the vCPU lifetime.
            unsafe { self.fd.set_xsave2(&xsave) }?;
            self.fd.set_fpu(&state.fpu)?;
            self.fd.set_debug_regs(&state.debug_regs)?;
            self.fd.set_regs(&state.regs)?;
            self.fd.set_mp_state(state.mp_state)?;
            self.fd.set_vcpu_events(&state.events)?;
            // Clear host-side run controls, not part of the guest CPU image.
            self.fd.set_kvm_immediate_exit(0);
            Ok(())
        };
        restore().map_err(|source| Error::ConfigureVcpu {
            id: self.id,
            operation: "restore CPU state",
            source,
        })
    }

    fn xsave_buffer(&self) -> io::Result<kvm_bindings::Xsave> {
        let size = self.xsave_size.max(size_of::<kvm_bindings::kvm_xsave>());
        let extra_words = (size - size_of::<kvm_bindings::kvm_xsave>()).div_ceil(size_of::<u32>());
        kvm_bindings::Xsave::new(extra_words)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[repr(C)]
    #[derive(Default)]
    struct ExitBuffer {
        run: kvm_run,
        port_bytes: [u8; 8],
    }

    impl ExitBuffer {
        fn decode(&mut self) -> Result<VcpuExit<'_>> {
            // SAFETY: run is the first field of this exclusive allocation.
            unsafe { decode_exit(7, &mut self.run, size_of::<Self>()) }
        }
    }

    #[test]
    fn port_exits_preserve_width_and_borrow_the_response_buffer() {
        let mut buffer = ExitBuffer::default();
        buffer.run.exit_reason = KVM_EXIT_IO;
        for size in [1, 2, 4] {
            buffer.run.__bindgen_anon_1.io = kvm_bindings::kvm_run__bindgen_ty_1__bindgen_ty_4 {
                direction: KVM_EXIT_IO_IN as u8,
                size,
                port: 0x3f8,
                count: 1,
                data_offset: std::mem::offset_of!(ExitBuffer, port_bytes) as u64,
            };
            let VcpuExit::IoIn { port, bytes } = buffer.decode().unwrap() else {
                panic!("expected input")
            };
            assert_eq!(port, 0x3f8);
            assert_eq!(bytes.len(), usize::from(size));
            bytes.fill(0x5a);
            buffer.run.__bindgen_anon_1.io.direction = KVM_EXIT_IO_OUT as u8;
            let VcpuExit::IoOut { port, bytes } = buffer.decode().unwrap() else {
                panic!("expected output")
            };
            assert_eq!(port, 0x3f8);
            assert_eq!(bytes, vec![0x5a; usize::from(size)]);
        }
        for (count, size, direction, offset) in [
            (2, 1, 0, size_of::<kvm_run>() as u64),
            (0, 1, 0, size_of::<kvm_run>() as u64),
            (1, 3, 0, size_of::<kvm_run>() as u64),
            (1, 1, 2, size_of::<kvm_run>() as u64),
            (1, 1, 0, 0),
            (1, 4, 0, u64::MAX),
            (1, 4, 0, (size_of::<ExitBuffer>() - 1) as u64),
        ] {
            buffer.run.__bindgen_anon_1.io = kvm_bindings::kvm_run__bindgen_ty_1__bindgen_ty_4 {
                direction,
                size,
                port: 0x3f8,
                count,
                data_offset: offset,
            };
            assert!(matches!(
                buffer.decode(),
                Err(Error::UnhandledExit { id: 7, .. })
            ));
        }
    }

    #[test]
    fn mmio_exits_preserve_address_width_and_read_responses() {
        let mut buffer = ExitBuffer::default();
        buffer.run.exit_reason = KVM_EXIT_MMIO;
        for len in [1, 2, 4, 8] {
            buffer.run.__bindgen_anon_1.mmio = kvm_bindings::kvm_run__bindgen_ty_1__bindgen_ty_6 {
                phys_addr: 0x1000_0000,
                data: [0; 8],
                len,
                is_write: 0,
            };
            let VcpuExit::MmioRead { guest_addr, bytes } = buffer.decode().unwrap() else {
                panic!("expected read")
            };
            assert_eq!(guest_addr, 0x1000_0000);
            assert_eq!(bytes.len(), len as usize);
            bytes.fill(0x42);
            buffer.run.__bindgen_anon_1.mmio.is_write = 1;
            let VcpuExit::MmioWrite { guest_addr, bytes } = buffer.decode().unwrap() else {
                panic!("expected write")
            };
            assert_eq!(guest_addr, 0x1000_0000);
            assert_eq!(bytes, vec![0x42; len as usize]);
        }
        for (len, is_write) in [(0, 0), (3, 0), (9, 0), (1, 2)] {
            buffer.run.__bindgen_anon_1.mmio.len = len;
            buffer.run.__bindgen_anon_1.mmio.is_write = is_write;
            assert!(buffer.decode().is_err());
        }
    }

    #[test]
    fn control_exits_distinguish_reset_shutdown_and_unsupported_events() {
        let mut buffer = ExitBuffer::default();
        for (reason, event, expected) in [
            (KVM_EXIT_INTR, 0, VcpuExit::Interrupted),
            (KVM_EXIT_HLT, 0, VcpuExit::Halted),
            (KVM_EXIT_SHUTDOWN, 0, VcpuExit::Reset),
            (
                KVM_EXIT_SYSTEM_EVENT,
                KVM_SYSTEM_EVENT_RESET,
                VcpuExit::Reset,
            ),
            (
                KVM_EXIT_SYSTEM_EVENT,
                KVM_SYSTEM_EVENT_SHUTDOWN,
                VcpuExit::Shutdown,
            ),
        ] {
            buffer.run.exit_reason = reason;
            buffer.run.__bindgen_anon_1.system_event.type_ = event;
            assert_eq!(
                std::mem::discriminant(&buffer.decode().unwrap()),
                std::mem::discriminant(&expected)
            );
        }
        for reason in [KVM_EXIT_SYSTEM_EVENT, u32::MAX] {
            buffer.run.exit_reason = reason;
            buffer.run.__bindgen_anon_1.system_event.type_ = u32::MAX;
            assert!(matches!(
                buffer.decode(),
                Err(Error::UnhandledExit { id: 7, .. })
            ));
        }
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_restore_rejects_xsave_and_xcr_shapes_before_writing_registers() {
        let vm = super::super::KvmVm::new().unwrap();
        let mut cpu = vm.create_vcpu(0).unwrap();
        cpu.set_cpu_features(vm.supported_cpuid(), &[]).unwrap();
        let valid = cpu.save_state().unwrap();
        let original = cpu.fd.get_regs().unwrap();
        for case in 0..4 {
            let mut state = valid.clone();
            state.regs.rax = original.rax ^ 0x1234;
            match case {
                0 => state.xsave.clear(),
                1 => {
                    state.xsave.pop();
                }
                2 => state.xsave.push(0),
                3 => state.xcrs.nr_xcrs = state.xcrs.xcrs.len() as u32 + 1,
                _ => unreachable!(),
            }
            let error = cpu.restore_state(&state).unwrap_err();
            assert!(
                matches!(error, Error::ConfigureVcpu { id: 0, operation: "restore CPU state", ref source }
                if source.kind() == io::ErrorKind::InvalidInput
                    && source.to_string() == "invalid XSAVE/XCR snapshot shape"),
                "{error:?}"
            );
            assert_eq!(cpu.fd.get_regs().unwrap(), original);
        }
        // A real capture is still accepted after every pre-write rejection.
        cpu.restore_state(&valid).unwrap();
        assert_eq!(cpu.fd.get_regs().unwrap(), valid.regs);
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_restore_rejects_a_cpu_after_interrupted_entry() {
        let vm = super::super::KvmVm::new().unwrap();
        let mut cpu = vm.create_vcpu(0).unwrap();
        cpu.set_cpu_features(vm.supported_cpuid(), &[]).unwrap();
        let state = cpu.save_state().unwrap();
        cpu.fd.set_kvm_immediate_exit(1);
        assert!(matches!(cpu.run().unwrap(), VcpuExit::Interrupted));
        let error = cpu.restore_state(&state).unwrap_err();
        assert!(matches!(error, Error::ConfigureVcpu { ref source, .. }
            if source.kind() == io::ErrorKind::InvalidInput
                && source.to_string() == "restore requires a fresh, never-entered vCPU"));
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_restore_handles_empty_and_multiple_msr_batches() {
        let mut failures = Vec::new();
        for count in [
            0,
            kvm_bindings::KVM_MAX_MSR_ENTRIES - 1,
            kvm_bindings::KVM_MAX_MSR_ENTRIES,
            kvm_bindings::KVM_MAX_MSR_ENTRIES + 1,
            4096,
        ] {
            // Failed restores are not transactional: use a fresh destination
            // for each boundary and report all failures, not just the first.
            let vm = super::super::KvmVm::new().unwrap();
            let mut cpu = vm.create_vcpu(0).unwrap();
            cpu.set_cpu_features(vm.supported_cpuid(), &[]).unwrap();
            let mut state = cpu.save_state().unwrap();
            state.msrs = (0..count)
                .map(|i| kvm_bindings::kvm_msr_entry {
                    index: 0xc0000102,
                    data: (i + 1) as u64,
                    ..Default::default()
                })
                .collect();
            // The codec's 4096-entry ceiling exceeds one KVM ioctl batch.
            let encoded = postcard::to_allocvec(&state).unwrap();
            let decoded = postcard::from_bytes(&encoded).unwrap();
            if let Err(error) = cpu.restore_state(&decoded) {
                failures.push((count, error));
                continue;
            }
            let actual = cpu.save_state().unwrap();
            assert_eq!(
                actual
                    .msrs
                    .iter()
                    .find(|e| e.index == 0xc0000102)
                    .unwrap()
                    .data,
                count as u64
            );
        }
        assert!(
            failures.is_empty(),
            "MSR batch restore failures: {failures:?}"
        );
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_restore_matches_kvm_for_a_changed_tsc_scale() {
        let vm = super::super::KvmVm::new().unwrap();
        let mut cpu = vm.create_vcpu(0).unwrap();
        cpu.set_cpu_features(vm.supported_cpuid(), &[]).unwrap();
        let mut state = cpu.save_state().unwrap();
        assert!(state.tsc_khz > 1);
        let original = state.tsc_khz;
        state.tsc_khz /= 2;
        // Query the real ioctl as the oracle: hosts without TSC scaling
        // reject a lower rate. Restore must preserve that failure too.
        let expected = cpu.fd.set_tsc_khz(state.tsc_khz);
        cpu.fd.set_tsc_khz(original).unwrap();
        match expected {
            Ok(()) => {
                cpu.restore_state(&state).unwrap();
                assert_eq!(cpu.fd.get_tsc_khz().unwrap(), state.tsc_khz);
            }
            Err(expected) => {
                let error = cpu.restore_state(&state).unwrap_err();
                assert!(
                    matches!(error, Error::ConfigureVcpu { operation: "restore CPU state", ref source, .. }
                    if source.raw_os_error() == Some(expected.errno()))
                );
            }
        }
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_restore_reports_the_first_rejected_msr() {
        let vm = super::super::KvmVm::new().unwrap();
        let mut cpu = vm.create_vcpu(0).unwrap();
        cpu.set_cpu_features(vm.supported_cpuid(), &[]).unwrap();
        let mut state = cpu.save_state().unwrap();
        state.msrs = vec![kvm_bindings::kvm_msr_entry {
            index: u32::MAX,
            ..Default::default()
        }];
        let error = cpu.restore_state(&state).unwrap_err();
        assert!(
            matches!(error, Error::ConfigureVcpu { operation: "restore CPU state", ref source, .. }
            if source.to_string().contains("first rejected index 0xffffffff"))
        );
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_vcpus_share_the_kvm_advertised_msr_index_cache() {
        let vm = super::super::KvmVm::new().unwrap();
        let first = vm.create_vcpu(0).unwrap();
        let indices = Arc::clone(&first.msr_indices);
        // One worker owns at most one reserved kick signal at a time.
        drop(first);
        let second = vm.create_vcpu(1).unwrap();
        let advertised = kvm_ioctls::Kvm::new()
            .unwrap()
            .get_msr_index_list()
            .unwrap();
        assert_eq!(&*indices, advertised.as_slice());
        assert!(Arc::ptr_eq(&indices, &second.msr_indices));
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_legacy_xsave_capture_uses_the_fixed_region() {
        let vm = super::super::KvmVm::new().unwrap();
        let mut cpu = vm.create_vcpu(0).unwrap();
        cpu.set_cpu_features(vm.supported_cpuid(), &[]).unwrap();
        // Exercise the pre-XSAVE2 fallback on an XSAVE2-capable host too.
        // GET_XSAVE is always the fixed-size ioctl; do not issue SET_XSAVE2
        // with a buffer smaller than the real destination's capability.
        cpu.xsave_size = 0;
        let fixed = cpu.fd.get_xsave().unwrap();
        let state = cpu.save_state().unwrap();
        assert_eq!(state.xsave.len(), XSAVE_REGION_WORDS);
        assert_eq!(state.xsave, fixed.region);
        for extra_bytes in [1, 4, 5] {
            cpu.xsave_size = size_of::<kvm_bindings::kvm_xsave>() + extra_bytes;
            assert_eq!(
                cpu.xsave_buffer().unwrap().as_slice().len(),
                extra_bytes.div_ceil(4)
            );
        }
    }

    #[test]
    fn completion_consumes_pending_io_only_after_interrupted_reentry() {
        let mut pending = PendingIo::default();
        pending.complete(|| panic!("no pending I/O")).unwrap();
        pending.0 = true;
        let error = pending
            .complete(|| Err(io::Error::from_raw_os_error(libc::EIO)))
            .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EIO));
        assert!(pending.0);
        assert!(pending.complete(|| Ok(())).is_err());
        assert!(pending.0);
        pending
            .complete(|| Err(io::Error::from_raw_os_error(libc::EINTR)))
            .unwrap();
        assert!(!pending.0);
        pending.complete(|| panic!("must not enter twice")).unwrap();
    }
}
