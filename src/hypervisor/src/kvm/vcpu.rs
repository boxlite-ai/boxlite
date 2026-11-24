// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{HashMap, HashSet},
    io,
    marker::PhantomData,
    ops::{Deref, DerefMut},
    os::fd::AsRawFd,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use kvm_bindings::{
    KVM_EXIT_HLT, KVM_EXIT_INTR, KVM_EXIT_IO, KVM_EXIT_IO_IN, KVM_EXIT_IO_OUT, KVM_EXIT_MMIO,
    KVM_EXIT_SHUTDOWN, KVM_EXIT_SYSTEM_EVENT, KVM_SYSTEM_EVENT_RESET, KVM_SYSTEM_EVENT_SHUTDOWN,
    KVM_VCPU_TSC_CTRL, KVM_VCPU_TSC_OFFSET, Msrs, kvm_device_attr, kvm_msr_entry, kvm_run,
    kvm_sregs,
};
use kvm_ioctls::{VcpuFd, VmFd};

use super::{
    KvmVcpuHandle,
    features::{
        MSR_IA32_TSC, check_written, extra_cpuid_gated_msr_indices, order_msrs_for_restore,
        snapshot_cpuid, snapshot_msrs, validate_cpuid_count, validate_restore_msrs,
        validate_snapshot_cpuid_features,
    },
    kick::WorkerSignal,
};
use crate::{Error, Result, VcpuExit, x86::MAX_SNAPSHOT_MSR_ENTRIES};

/// Number of u32 words in kvm_xsave.region, before its flexible-array tail.
const XSAVE_REGION_WORDS: usize = 1024;

/// KVM_SET_MSRS returns E2BIG when nmsrs >= KVM_MAX_MSR_ENTRIES;
/// each ioctl can write at most 255 entries.
const MAX_MSR_BATCH_ENTRIES: usize = kvm_bindings::KVM_MAX_MSR_ENTRIES - 1;

pub(super) const MSR_KVM_WALL_CLOCK: u32 = 0x11;
pub(super) const MSR_KVM_WALL_CLOCK_NEW: u32 = 0x4b56_4d00;

// Linux x86_64 _IO(KVMIO, 0xa3), returning the frequency directly.
const KVM_GET_TSC_KHZ: libc::c_ulong = 0x0000_aea3;

fn parse_tsc_khz(ret: libc::c_int, last_err: io::Error) -> io::Result<u32> {
    match ret {
        1.. => Ok(ret as u32),
        0 => Err(io::Error::other("KVM_GET_TSC_KHZ returned zero")),
        _ if last_err.raw_os_error().is_some_and(|errno| errno != 0) => Err(last_err),
        _ => Err(io::Error::other(format!(
            "KVM_GET_TSC_KHZ failed with {ret}"
        ))),
    }
}

fn get_tsc_khz(fd: &VcpuFd) -> io::Result<u32> {
    // SAFETY: this ioctl takes no pointer argument and uses a live vCPU fd.
    let ret = unsafe { libc::ioctl(fd.as_raw_fd(), KVM_GET_TSC_KHZ as _, 0 as libc::c_ulong) };
    parse_tsc_khz(ret, io::Error::last_os_error())
}

// Linux x86_64 _IOW(KVMIO, nr, struct kvm_device_attr).
const KVM_SET_DEVICE_ATTR: libc::c_ulong = 0x4018_aee1;
const KVM_GET_DEVICE_ATTR: libc::c_ulong = 0x4018_aee2;
const KVM_HAS_DEVICE_ATTR: libc::c_ulong = 0x4018_aee3;
const _: () = assert!(size_of::<kvm_device_attr>() == 24);

fn tsc_offset_ioctl(fd: &VcpuFd, request: libc::c_ulong, addr: u64) -> io::Result<bool> {
    let attr = kvm_device_attr {
        group: KVM_VCPU_TSC_CTRL,
        attr: u64::from(KVM_VCPU_TSC_OFFSET),
        addr,
        ..Default::default()
    };
    // SAFETY: attr lives through the synchronous ioctl. Its addr is unused for
    // HAS and points to a u64 writable for GET and readable for SET.
    if unsafe { libc::ioctl(fd.as_raw_fd(), request as _, &raw const attr) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ENXIO) => Ok(false),
        Some(libc::ENOTTY | libc::EINVAL) if request == KVM_HAS_DEVICE_ATTR => Ok(false),
        _ => Err(error),
    }
}

#[derive(Debug)]
pub(super) struct CachedIoError {
    raw_os_error: Option<i32>,
    kind: io::ErrorKind,
    message: String,
}

impl CachedIoError {
    pub(super) fn from_io(error: io::Error) -> Self {
        Self {
            raw_os_error: error.raw_os_error(),
            kind: error.kind(),
            message: error.to_string(),
        }
    }

    fn to_io(&self) -> io::Error {
        match self.raw_os_error {
            Some(errno) => io::Error::from_raw_os_error(errno),
            None => io::Error::new(self.kind, self.message.clone()),
        }
    }
}

#[derive(Debug, Default)]
struct TscSaveAnchor {
    active: AtomicBool,
    state: Mutex<TscSaveState>,
}

#[derive(Debug, Default)]
struct TscSaveState {
    vm_clock_ns: Option<u64>,
    per_freq: HashMap<u32, u64>,
    saved_vcpus: HashSet<u32>,
}

impl TscSaveState {
    fn clock_for_vcpu_save(&self, id: u32) -> io::Result<u64> {
        let clock_ns = self
            .vm_clock_ns
            .ok_or_else(|| io::Error::other("save VM state before saving vCPU state"))?;
        if self.saved_vcpus.contains(&id) {
            return Err(io::Error::other(
                "save VM state before recapturing vCPU state",
            ));
        }
        Ok(clock_ns)
    }
}

impl TscSaveAnchor {
    fn record_vm_clock(&self, clock_ns: u64) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.per_freq.clear();
        state.saved_vcpus.clear();
        state.vm_clock_ns = Some(clock_ns);
        self.active.store(true, Ordering::Release);
    }

    fn check_vcpu_save(&self, id: u32) -> io::Result<()> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.clock_for_vcpu_save(id)?;
        Ok(())
    }

    fn commit_vcpu_save(
        &self,
        id: u32,
        normalize_tsc: impl FnOnce(u64, &mut HashMap<u32, u64>) -> io::Result<()>,
    ) -> io::Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let clock_ns = state.clock_for_vcpu_save(id)?;
        normalize_tsc(clock_ns, &mut state.per_freq)?;
        state.saved_vcpus.insert(id);
        self.active.store(true, Ordering::Release);
        Ok(())
    }

    fn clear(&self) {
        // Capture requires quiescent vCPUs. The flag bypasses the mutex on
        // normal guest entry and is set while holding the capture lock.
        if self.active.load(Ordering::Acquire) {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            *state = TscSaveState::default();
            self.active.store(false, Ordering::Release);
        }
    }
}

#[derive(Debug, Default)]
struct TscRestoreAnchor {
    state: Mutex<TscRestoreState>,
}

#[derive(Debug, Default)]
struct TscRestoreState {
    target_clock_ns: Option<u64>,
    per_freq: HashMap<u32, u64>,
}

fn ns_to_tsc_cycles(elapsed_ns: u64, tsc_khz: u32) -> u64 {
    ((u128::from(elapsed_ns) * u128::from(tsc_khz)) / 1_000_000) as u64
}

fn forward_clock_delta(before: u64, after: u64) -> Option<u64> {
    // Adjacent clock samples are less than half the u64 range apart. Modular
    // subtraction then distinguishes a short forward wrap from a backward step.
    let delta = after.wrapping_sub(before);
    (delta <= i64::MAX as u64).then_some(delta)
}

fn anchored_scaled_tsc(
    scaled_now: u64,
    now_clock_ns: u64,
    anchor_clock_ns: u64,
    tsc_khz: u32,
) -> Option<u64> {
    let elapsed_ns = forward_clock_delta(anchor_clock_ns, now_clock_ns)?;
    Some(scaled_now.wrapping_sub(ns_to_tsc_cycles(elapsed_ns, tsc_khz)))
}

fn sample_scaled_tsc_with(
    anchor_ns: u64,
    tsc_khz: u32,
    mut sample: impl FnMut() -> io::Result<(u64, u64, u64)>,
) -> io::Result<u64> {
    const MAX_ATTEMPTS: usize = 5;
    const MAX_SAMPLE_WINDOW_NS: u64 = 1_000_000;

    let mut best = None;
    for _ in 0..MAX_ATTEMPTS {
        let (before, scaled_now, after) = sample()?;
        let Some(window_ns) = forward_clock_delta(before, after) else {
            continue;
        };
        let midpoint = before.wrapping_add(window_ns / 2);
        let Some(anchored) = anchored_scaled_tsc(scaled_now, midpoint, anchor_ns, tsc_khz) else {
            continue;
        };
        if window_ns <= MAX_SAMPLE_WINDOW_NS {
            return Ok(anchored);
        }
        if best.is_none_or(|(best_window, _)| window_ns < best_window) {
            best = Some((window_ns, anchored));
        }
    }
    best.map(|(_, anchored)| anchored)
        .ok_or_else(|| io::Error::other("KVM clock moved backward during TSC sampling"))
}

fn scaled_tsc_anchor(
    per_freq: &mut HashMap<u32, u64>,
    tsc_khz: u32,
    sample: impl FnOnce() -> io::Result<Option<u64>>,
) -> io::Result<Option<u64>> {
    if let Some(&anchor) = per_freq.get(&tsc_khz) {
        return Ok(Some(anchor));
    }
    let anchor = sample()?;
    if let Some(anchor) = anchor {
        per_freq.insert(tsc_khz, anchor);
    }
    Ok(anchor)
}

#[derive(Debug)]
pub(super) struct VcpuSnapshotShared {
    vm_fd: Arc<VmFd>,
    msr_indices: std::result::Result<Arc<[u32]>, CachedIoError>,
    wall_clock_lock: Mutex<()>,
    tsc_save_anchor: TscSaveAnchor,
    tsc_restore_anchor: TscRestoreAnchor,
}

impl VcpuSnapshotShared {
    pub(super) fn new(
        vm_fd: Arc<VmFd>,
        msr_indices: std::result::Result<Arc<[u32]>, CachedIoError>,
    ) -> Self {
        Self {
            vm_fd,
            msr_indices,
            wall_clock_lock: Mutex::default(),
            tsc_save_anchor: TscSaveAnchor::default(),
            tsc_restore_anchor: TscRestoreAnchor::default(),
        }
    }

    fn msr_indices(&self) -> io::Result<&Arc<[u32]>> {
        self.msr_indices.as_ref().map_err(CachedIoError::to_io)
    }

    pub(super) fn record_tsc_save_clock(&self, clock_ns: u64) {
        self.tsc_save_anchor.record_vm_clock(clock_ns);
    }

    pub(super) fn clear_tsc_save_anchor(&self) {
        self.tsc_save_anchor.clear();
    }

    pub(super) fn record_tsc_restore_clock(&self, clock_ns: u64) {
        let mut state = self
            .tsc_restore_anchor
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        state.target_clock_ns = Some(clock_ns);
        state.per_freq.clear();
    }
}

#[derive(Debug)]
pub(super) struct SnapshotVcpuFd {
    inner: VcpuFd,
    snapshot: Arc<VcpuSnapshotShared>,
}

impl SnapshotVcpuFd {
    pub(super) fn set_sregs(
        &self,
        state: &kvm_sregs,
    ) -> std::result::Result<(), kvm_ioctls::Error> {
        // Boot register setup reaches this write through both public entry points.
        self.clear_tsc_save_anchor();
        self.inner.set_sregs(state)
    }

    pub(super) fn clear_tsc_save_anchor(&self) {
        self.snapshot.clear_tsc_save_anchor();
    }
}

impl Deref for SnapshotVcpuFd {
    type Target = VcpuFd;

    fn deref(&self) -> &VcpuFd {
        &self.inner
    }
}

impl DerefMut for SnapshotVcpuFd {
    fn deref_mut(&mut self) -> &mut VcpuFd {
        &mut self.inner
    }
}

/// A Linux x86_64 vCPU bound to its creating thread.
///
/// Creation leaves KVM's reset register state intact and reserves the kick
/// signal on this worker until drop. The caller supplies entry registers.
#[derive(Debug)]
pub struct KvmVcpu {
    pub(super) fd: SnapshotVcpuFd,
    pub(super) id: u32,
    run_size: usize,
    pending_io: PendingIo,
    entered: bool,
    restore_started: bool,
    xsave_size: std::result::Result<usize, CachedIoError>,
    tsc_offset: Option<bool>,
    kick: WorkerSignal,
    _thread_bound: PhantomData<Rc<()>>,
}

impl KvmVcpu {
    pub(super) fn new(
        fd: VcpuFd,
        id: u32,
        run_size: usize,
        kick: WorkerSignal,
        xsave_size: std::result::Result<usize, CachedIoError>,
        snapshot: Arc<VcpuSnapshotShared>,
    ) -> Self {
        Self {
            fd: SnapshotVcpuFd {
                inner: fd,
                snapshot,
            },
            id,
            run_size,
            pending_io: PendingIo::default(),
            entered: false,
            restore_started: false,
            xsave_size,
            tsc_offset: None,
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
        self.fd.clear_tsc_save_anchor();
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
                self.fd.clear_tsc_save_anchor();
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

    /// Notifies an enabled KVM pvclock that its vCPU was stopped.
    pub fn notify_guest_stopped(&mut self) -> Result<()> {
        crate::vcpu::kvmclock_ctrl_result(self.fd.kvmclock_ctrl().map_err(io::Error::from)).map_err(
            |source| Error::ConfigureVcpu {
                id: self.id,
                operation: "notify guest stopped",
                source,
            },
        )
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
        Self::notify_guest_stopped(self)
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

fn is_paged_32bit_pae(sregs: &kvm_sregs) -> bool {
    const CR0_PG: u64 = 1 << 31;
    const CR4_PAE: u64 = 1 << 5;
    const EFER_LMA: u64 = 1 << 10;
    sregs.cr0 & CR0_PG != 0 && sregs.cr4 & CR4_PAE != 0 && sregs.efer & EFER_LMA == 0
}

fn validate_snapshot_paging(sregs: &kvm_sregs) -> io::Result<()> {
    if is_paged_32bit_pae(sregs) {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "32-bit PAE paging state is unsupported because SREGS omits PDPTRs",
        ));
    }
    Ok(())
}

impl KvmVcpu {
    fn xsave_size(&self) -> io::Result<usize> {
        self.xsave_size
            .as_ref()
            .copied()
            .map_err(CachedIoError::to_io)
    }

    pub(super) fn has_tsc_offset(&mut self) -> io::Result<bool> {
        if let Some(supported) = self.tsc_offset {
            return Ok(supported);
        }
        let supported = tsc_offset_ioctl(&self.fd, KVM_HAS_DEVICE_ATTR, 0)?;
        self.tsc_offset = Some(supported);
        Ok(supported)
    }

    pub(super) fn get_tsc_offset(&self) -> io::Result<Option<u64>> {
        if self.tsc_offset != Some(true) {
            return Ok(None);
        }
        let mut offset = 0u64;
        tsc_offset_ioctl(&self.fd, KVM_GET_DEVICE_ATTR, &raw mut offset as u64)
            .map(|supported| supported.then_some(offset))
    }

    pub(super) fn set_tsc_offset(&self, offset: u64) -> io::Result<bool> {
        if self.tsc_offset != Some(true) {
            return Ok(false);
        }
        tsc_offset_ioctl(&self.fd, KVM_SET_DEVICE_ATTR, &raw const offset as u64)
    }

    fn sample_scaled_tsc(
        &self,
        offset: u64,
        tsc_khz: u32,
        anchor_ns: Option<u64>,
    ) -> io::Result<u64> {
        let read_scaled_tsc = || {
            let msrs = snapshot_msrs(&self.fd, &[MSR_IA32_TSC])?;
            msrs.first()
                .map(|tsc| tsc.data.wrapping_sub(offset))
                .ok_or_else(|| io::Error::other("KVM did not return IA32_TSC"))
        };
        let Some(anchor_ns) = anchor_ns else {
            return read_scaled_tsc();
        };
        let vm_fd = &self.fd.snapshot.vm_fd;
        sample_scaled_tsc_with(anchor_ns, tsc_khz, || {
            let before = vm_fd.get_clock()?.clock;
            let scaled_now = read_scaled_tsc()?;
            let after = vm_fd.get_clock()?.clock;
            Ok((before, scaled_now, after))
        })
    }

    fn commit_saved_state(&self, msrs: &mut [kvm_msr_entry], tsc_khz: u32) -> io::Result<()> {
        self.fd
            .snapshot
            .tsc_save_anchor
            .commit_vcpu_save(self.id, |clock_ns, per_freq| {
                let Some(tsc) = msrs.iter_mut().find(|entry| entry.index == MSR_IA32_TSC) else {
                    return Ok(());
                };
                let Some(offset) = self.get_tsc_offset()? else {
                    return Ok(());
                };
                if let Some(host_tsc) = scaled_tsc_anchor(per_freq, tsc_khz, || {
                    self.sample_scaled_tsc(offset, tsc_khz, Some(clock_ns))
                        .map(Some)
                })? {
                    tsc.data = host_tsc.wrapping_add(offset);
                }
                Ok(())
            })
    }

    fn restore_tsc(&self, tsc: kvm_msr_entry, tsc_khz: u32) -> io::Result<()> {
        if self.tsc_offset != Some(true) {
            return self.write_msr_batches(&[tsc]);
        }
        let mut state = self
            .fd
            .snapshot
            .tsc_restore_anchor
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let clock_ns = state.target_clock_ns;
        let Some(host_tsc) = scaled_tsc_anchor(&mut state.per_freq, tsc_khz, || {
            self.get_tsc_offset()?
                .map(|offset| self.sample_scaled_tsc(offset, tsc_khz, clock_ns))
                .transpose()
        })?
        else {
            return self.write_msr_batches(&[tsc]);
        };
        if self.set_tsc_offset(tsc.data.wrapping_sub(host_tsc))? {
            Ok(())
        } else {
            self.write_msr_batches(&[tsc])
        }
    }

    fn write_msr_batches(&self, entries: &[kvm_msr_entry]) -> io::Result<()> {
        for chunk in entries.chunks(MAX_MSR_BATCH_ENTRIES) {
            let msrs = Msrs::from_entries(chunk)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
            let written = if chunk
                .iter()
                .any(|entry| matches!(entry.index, MSR_KVM_WALL_CLOCK | MSR_KVM_WALL_CLOCK_NEW))
            {
                // Each vCPU can rewrite the same pvclock sequence counter.
                let _guard = self
                    .fd
                    .snapshot
                    .wall_clock_lock
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                self.fd.set_msrs(&msrs)?
            } else {
                self.fd.set_msrs(&msrs)?
            };
            check_written(&msrs, written)?;
        }
        Ok(())
    }

    /// Captures an architecture- and host-version-specific CPU image.
    /// Complete pending I/O and stop all VM state producers before saving VM
    /// state, then capture each vCPU once. A failed capture can be retried in the
    /// same round. Capture never enters KVM_RUN.
    ///
    /// After preflight, read `KVM_GET_MP_STATE` so `kvm_apic_accept_events()` can apply
    /// pending INIT/SIPI events and update `CS:RIP` and related state. Then read
    /// `KVM_GET_VCPU_EVENTS` before `sregs` and `debug_regs` to capture any pending
    /// `#PF`/`#DB` payload materialized into `CR2`/`DR6`. Capture CPUID after
    /// these reads so runtime bits such as OSXSAVE match the saved registers.
    pub fn save_state(&mut self) -> Result<crate::X86VcpuState> {
        let mut save = || -> io::Result<crate::X86VcpuState> {
            if self.pending_io.0 {
                return Err(io::Error::other("complete pending I/O before saving"));
            }
            self.fd.snapshot.tsc_save_anchor.check_vcpu_save(self.id)?;
            let read_cpuid = |fd: &VcpuFd| -> io::Result<_> {
                let cpuid = fd.get_cpuid2(kvm_bindings::KVM_MAX_CPUID_ENTRIES)?;
                validate_cpuid_count(cpuid.as_slice().len())?;
                validate_snapshot_cpuid_features(cpuid.as_slice())?;
                Ok(cpuid)
            };
            read_cpuid(&self.fd)?;
            let xsave_size = self.xsave_size()?;
            self.has_tsc_offset()?;
            let base_msr_indices = self.fd.snapshot.msr_indices()?;
            let tsc_khz = get_tsc_khz(&self.fd)?;
            let mut xsave = Self::xsave_buffer(xsave_size)?;
            let mp_state = self.fd.get_mp_state()?;
            let events = self.fd.get_vcpu_events()?;
            let cpuid = read_cpuid(&self.fd)?;
            let cpuid = cpuid.as_slice();
            let sregs = self.fd.get_sregs()?;
            validate_snapshot_paging(&sregs)?;
            if xsave_size == 0 {
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
            // Sample timer MSRs before LAPIC state so an intervening timer
            // expiration can be reflected in the captured interrupt state.
            let mut msrs = snapshot_msrs(&self.fd, base_msr_indices)?;
            msrs.extend(snapshot_msrs(
                &self.fd,
                &extra_cpuid_gated_msr_indices(cpuid),
            )?);
            if msrs.len() > MAX_SNAPSHOT_MSR_ENTRIES {
                return Err(io::Error::other("snapshot MSR count exceeds the limit"));
            }
            let mut state = crate::X86VcpuState {
                regs: self.fd.get_regs()?,
                sregs,
                fpu: self.fd.get_fpu()?,
                cpuid: cpuid.to_vec(),
                msrs,
                xsave: words,
                xcrs: self.fd.get_xcrs()?,
                debug_regs: self.fd.get_debug_regs()?,
                events,
                mp_state,
                lapic: self.fd.get_lapic()?,
                tsc_khz,
            };
            self.commit_saved_state(&mut state.msrs, state.tsc_khz)?;
            Ok(state)
        };
        save().map_err(|source| Error::ConfigureVcpu {
            id: self.id,
            operation: "save CPU state",
            source,
        })
    }

    #[cfg(test)]
    pub(super) fn save_state_with_pending_io(&mut self) -> Result<crate::X86VcpuState> {
        self.pending_io.0 = true;
        let state = self.save_state();
        self.pending_io.0 = false;
        state
    }

    /// Overwrites a fresh, never-entered vCPU; never executes guest code.
    /// Read-only validation and capability probes permit a retry on failure.
    /// Once `KVM_SET_CPUID2` is attempted, any error can leave the vCPU partially
    /// mutated, including a read error during TSC restore. Discard the destination VM.
    ///
    /// CPUID must precede CPUID-gated MSRs/XCRs.
    /// TSC scaling precedes TSC writes; SREGS precedes REGS and establishes mode
    /// and APIC base. LAPIC precedes MSRs so its timer setup cannot clobber the
    /// saved TSC deadline. TSC_ADJUST precedes the TSC offset. The async page-fault
    /// interrupt vector precedes its enable MSR, and SGX launch key hashes precede
    /// IA32_FEATURE_CONTROL. IA32_PERF_CAPABILITIES precedes the other PMU MSRs.
    /// MSRs (including XSS/XFD) precede XCRS/XSAVE. KVM_SET_XSAVE restores the
    /// authoritative x87, SSE and extended state.
    /// Debug/REGS follow mode setup, MP state and events are last (LAPIC/SREGS
    /// can change pending events).
    ///
    /// MSR_KVM_WALL_CLOCK and MSR_KVM_WALL_CLOCK_NEW update the VM-global
    /// wall_clock and write the epoch into guest RAM. Call
    /// [`crate::X86Vm::restore_before_vcpus`] before restoring any vCPU.
    pub fn restore_state(&mut self, state: &crate::X86VcpuState) -> Result<()> {
        let mut restore = || -> io::Result<()> {
            let invalid = |message| io::Error::new(io::ErrorKind::InvalidInput, message);
            if self.entered || self.pending_io.0 || self.restore_started {
                return Err(invalid("restore requires a fresh, never-entered vCPU"));
            }
            let cpuid = snapshot_cpuid(&state.cpuid)?;
            validate_snapshot_cpuid_features(&state.cpuid)?;
            validate_snapshot_paging(&state.sregs)?;
            if state.tsc_khz == 0 {
                return Err(invalid("TSC frequency must be nonzero"));
            }
            validate_restore_msrs(&state.msrs, &state.cpuid)?;
            let xsave_size = self.xsave_size()?;
            self.has_tsc_offset()?;
            let mut xsave = Self::xsave_buffer(xsave_size)?;
            if state.xsave.len() != XSAVE_REGION_WORDS + xsave.as_slice().len()
                || state.xcrs.nr_xcrs as usize > state.xcrs.xcrs.len()
                || state.xcrs.flags != 0
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
            let current_khz = get_tsc_khz(&self.fd)?;
            let plan = order_msrs_for_restore(&state.msrs);
            self.fd.clear_tsc_save_anchor();
            self.restore_started = true;
            self.fd.set_cpuid2(&cpuid)?;
            if current_khz != state.tsc_khz {
                self.fd.set_tsc_khz(state.tsc_khz)?;
            }
            self.fd.set_sregs(&state.sregs)?;
            self.fd.set_lapic(&state.lapic)?;
            self.write_msr_batches(&plan.before_tsc)?;
            if let Some(tsc) = plan.tsc {
                self.restore_tsc(tsc, state.tsc_khz)?;
            }
            self.write_msr_batches(&plan.after_tsc)?;
            if state.xcrs.nr_xcrs > 0 {
                self.fd.set_xcrs(&state.xcrs)?;
            }
            // SAFETY: destination-sized allocation, checked above; no dynamic
            // XSTATE permission changes are allowed during the vCPU lifetime.
            unsafe {
                if xsave_size == 0 {
                    self.fd.set_xsave(&xsave.as_fam_struct_ref().xsave)
                } else {
                    self.fd.set_xsave2(&xsave)
                }
            }?;
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

    fn xsave_buffer(xsave_size: usize) -> io::Result<kvm_bindings::Xsave> {
        let size = xsave_size.max(size_of::<kvm_bindings::kvm_xsave>());
        let extra_words = (size - size_of::<kvm_bindings::kvm_xsave>()).div_ceil(size_of::<u32>());
        kvm_bindings::Xsave::new(extra_words)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        KvmVm,
        features::{build_snapshot_msr_indices, kvm_msr_index_list},
    };
    use super::*;

    fn snapshot_cpu(vm: &KvmVm) -> KvmVcpu {
        let mut cpuid = vm.supported_cpuid().to_vec();
        for entry in &mut cpuid {
            if entry.leaf == 7 && (!entry.subleaf_required || entry.subleaf == 0) {
                entry.ecx &= !(1 << 7); // CET shadow stack is outside the snapshot contract.
            }
        }
        let mut cpu = vm.create_vcpu(0).unwrap();
        cpu.set_cpu_features(&cpuid, &[]).unwrap();
        cpu
    }

    #[test]
    fn cached_io_errors_preserve_errno_or_kind_and_message() {
        for original in [
            io::Error::from_raw_os_error(libc::EPERM),
            io::Error::new(io::ErrorKind::InvalidData, "invalid size"),
        ] {
            let errno = original.raw_os_error();
            let kind = original.kind();
            let message = original.to_string();
            let cached = CachedIoError::from_io(original);
            for error in [cached.to_io(), cached.to_io()] {
                assert_eq!(error.raw_os_error(), errno);
                assert_eq!(error.kind(), kind);
                assert_eq!(error.to_string(), message);
            }
        }
    }

    #[test]
    fn tsc_khz_ioctl_parses_frequency_and_preserves_errno() {
        assert_eq!(KVM_GET_TSC_KHZ, 0xaea3);
        let parse = |ret| parse_tsc_khz(ret, io::Error::from_raw_os_error(libc::EPERM));
        assert_eq!(parse(1).unwrap(), 1);
        assert_eq!(parse(i32::MAX).unwrap(), i32::MAX as u32);
        assert_eq!(
            parse(0).unwrap_err().to_string(),
            "KVM_GET_TSC_KHZ returned zero"
        );
        assert_eq!(parse(-1).unwrap_err().raw_os_error(), Some(libc::EPERM));
        assert_eq!(
            parse_tsc_khz(-1, io::Error::from_raw_os_error(0))
                .unwrap_err()
                .raw_os_error(),
            None
        );
    }

    #[test]
    fn clock_delta_converts_with_wide_arithmetic_and_wrapping_tsc() {
        assert_eq!(ns_to_tsc_cycles(1_500_000, 1234), 1851);
        assert_eq!(ns_to_tsc_cycles(999_999, 1), 0);
        assert_eq!(ns_to_tsc_cycles(u64::MAX, 1_000_000), u64::MAX);
        assert_eq!(ns_to_tsc_cycles(u64::MAX, 2_000_000), u64::MAX - 1);
        assert_eq!(anchored_scaled_tsc(10, 4, 9, 1_000_000), None);
        assert_eq!(anchored_scaled_tsc(10, 9, 9, 1_000_000), Some(10));
        assert_eq!(anchored_scaled_tsc(2, 9, 5, 1_000_000), Some(u64::MAX - 1));
    }

    #[test]
    fn clock_anchor_handles_a_short_forward_wraparound() {
        assert_eq!(anchored_scaled_tsc(10, 2, u64::MAX - 1, 1_000_000), Some(6));
    }

    #[test]
    fn tsc_sampling_handles_a_window_that_wraps_past_u64_max() {
        let tsc =
            sample_scaled_tsc_with(u64::MAX - 5, 1_000_000, || Ok((u64::MAX - 3, 10, 4))).unwrap();
        assert_eq!(tsc, 4);
    }

    #[test]
    fn tsc_sampling_retries_midpoints_before_the_anchor() {
        let mut windows = [
            (10, 100, 20),
            (999_994, 200, 1_000_002),
            (1_000_002, 600_002, 2_000_002),
        ]
        .into_iter();
        let tsc =
            sample_scaled_tsc_with(1_000_000, 1_000_000, || Ok(windows.next().unwrap())).unwrap();
        assert_eq!(tsc, 100_000);
    }

    #[test]
    fn tsc_sampling_errors_after_five_midpoints_before_the_anchor() {
        let mut attempts = 0;
        let error = sample_scaled_tsc_with(100, 1_000_000, || {
            attempts += 1;
            Ok((10, 50, 20))
        })
        .unwrap_err();
        assert_eq!(attempts, 5);
        assert_eq!(
            error.to_string(),
            "KVM clock moved backward during TSC sampling"
        );
    }

    #[test]
    fn tsc_sampling_uses_the_narrowest_of_five_wide_windows() {
        let mut windows = [
            (0, 10_000_000, 4_000_000),
            (4_000_000, 10_000_000, 7_000_000),
            (7_000_000, 10_000_000, 8_500_000),
            (8_500_000, 10_000_000, 12_000_000),
            (12_000_000, 15_000_000, 14_500_000),
        ]
        .into_iter();
        let tsc = sample_scaled_tsc_with(0, 1_000_000, || Ok(windows.next().unwrap())).unwrap();
        assert_eq!(tsc, 2_250_000);
        assert_eq!(windows.next(), None);
    }

    #[test]
    fn tsc_sampling_propagates_ioctl_errors_after_a_wide_window() {
        let mut windows = [
            Ok((0, 3_000_000, 2_000_000)),
            Err(io::Error::from_raw_os_error(libc::EIO)),
        ]
        .into_iter();
        let error = sample_scaled_tsc_with(0, 1_000_000, || windows.next().unwrap()).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EIO));
    }

    #[test]
    fn clock_anchors_reuse_each_frequency_independently() {
        let mut per_freq = HashMap::new();
        let anchor_ns = 1_000_000;
        for (khz, sampled_clock_ns, scaled_now, expected) in
            [(1000, 2_000_000, 3000, 2000), (2000, 3_000_000, 5000, 1000)]
        {
            assert_eq!(
                scaled_tsc_anchor(&mut per_freq, khz, || {
                    Ok(anchored_scaled_tsc(
                        scaled_now,
                        sampled_clock_ns,
                        anchor_ns,
                        khz,
                    ))
                })
                .unwrap(),
                Some(expected)
            );
        }
        assert_eq!(
            scaled_tsc_anchor(&mut per_freq, 2000, || panic!("frequency already sampled")).unwrap(),
            Some(1000)
        );
        assert_eq!(per_freq, HashMap::from([(1000, 2000), (2000, 1000)]));
    }

    #[test]
    fn tsc_save_requires_vm_clock_and_rejects_duplicate_vcpus() {
        let anchor = TscSaveAnchor::default();
        let no_vm = "save VM state before saving vCPU state";
        let duplicate = "save VM state before recapturing vCPU state";
        let must_reject_commit = |message| {
            let error = anchor
                .commit_vcpu_save(0, |_, _| panic!("invalid capture reached normalization"))
                .unwrap_err();
            assert_eq!(error.to_string(), message);
        };
        assert_eq!(anchor.check_vcpu_save(0).unwrap_err().to_string(), no_vm);
        must_reject_commit(no_vm);

        // Even a successful capture without TSC normalization consumes its slot.
        anchor.record_vm_clock(1_000);
        anchor.check_vcpu_save(0).unwrap();
        anchor.commit_vcpu_save(0, |_, _| Ok(())).unwrap();
        assert_eq!(
            anchor.check_vcpu_save(0).unwrap_err().to_string(),
            duplicate
        );
        must_reject_commit(duplicate);

        anchor.check_vcpu_save(1).unwrap();
        anchor.clear();
        assert!(!anchor.active.load(Ordering::Acquire));
        assert_eq!(anchor.check_vcpu_save(1).unwrap_err().to_string(), no_vm);
        must_reject_commit(no_vm);
        anchor.record_vm_clock(2_000);
        anchor.check_vcpu_save(0).unwrap();
        anchor.commit_vcpu_save(0, |_, _| Ok(())).unwrap();
    }

    #[test]
    fn tsc_save_shares_tsc_and_reanchors_each_round() {
        let anchor = TscSaveAnchor::default();
        let tsc_khz = 1_000_000;
        let capture = |id, sampled_clock_ns, sampled_tsc| {
            let mut tsc = None;
            anchor
                .commit_vcpu_save(id, |clock_ns, per_freq| {
                    tsc = scaled_tsc_anchor(per_freq, tsc_khz, || {
                        Ok(anchored_scaled_tsc(
                            sampled_tsc,
                            sampled_clock_ns,
                            clock_ns,
                            tsc_khz,
                        ))
                    })?;
                    Ok(())
                })
                .unwrap();
            tsc.unwrap()
        };

        anchor.record_vm_clock(1_000);
        assert_eq!(capture(0, 1_100, 10_100), 10_000);
        assert_eq!(capture(1, 1_200, 10_201), 10_000);

        anchor.record_vm_clock(2_000);
        assert_eq!(capture(0, 2_100, 11_100), 11_000);
        assert_eq!(capture(1, 2_200, 11_201), 11_000);
    }

    #[test]
    fn failed_tsc_save_preserves_the_round_for_retry() {
        let anchor = TscSaveAnchor::default();
        anchor.record_vm_clock(1_000);
        let error = anchor
            .commit_vcpu_save(0, |_, per_freq| {
                scaled_tsc_anchor(per_freq, 1_000, || Err(io::Error::other("sample failed")))?;
                Ok(())
            })
            .unwrap_err();
        assert_eq!(error.to_string(), "sample failed");

        anchor
            .commit_vcpu_save(1, |clock_ns, per_freq| {
                assert_eq!(clock_ns, 1_000);
                assert_eq!(
                    scaled_tsc_anchor(per_freq, 1_000, || Ok(Some(900)))?,
                    Some(900)
                );
                Ok(())
            })
            .unwrap();
        anchor.check_vcpu_save(0).unwrap();
        anchor
            .commit_vcpu_save(0, |clock_ns, per_freq| {
                assert_eq!(clock_ns, 1_000);
                assert_eq!(
                    scaled_tsc_anchor(per_freq, 1_000, || panic!("frequency already sampled"))?,
                    Some(900)
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn paged_32bit_pae_requires_pg_and_pae_without_lma() {
        for pg in [false, true] {
            for pae in [false, true] {
                for lma in [false, true] {
                    let sregs = kvm_sregs {
                        cr0: u64::from(pg) << 31,
                        cr4: u64::from(pae) << 5,
                        efer: u64::from(lma) << 10,
                        ..Default::default()
                    };
                    assert_eq!(
                        is_paged_32bit_pae(&sregs),
                        pg && pae && !lma,
                        "{pg}, {pae}, {lma}"
                    );
                }
            }
        }
    }

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
    fn kvm_tsc_device_attr_ioctl_numbers() {
        // _IOW packs the write bit, structure size, KVMIO type and request.
        let iow = |nr: libc::c_ulong| {
            (1 << 30) | ((size_of::<kvm_device_attr>() as libc::c_ulong) << 16) | (0xae << 8) | nr
        };
        assert_eq!(KVM_SET_DEVICE_ATTR, iow(0xe1));
        assert_eq!(KVM_GET_DEVICE_ATTR, iow(0xe2));
        assert_eq!(KVM_HAS_DEVICE_ATTR, iow(0xe3));
        assert_eq!((KVM_VCPU_TSC_CTRL, KVM_VCPU_TSC_OFFSET), (0, 0));
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_save_rejects_unconfigured_empty_cpuid() {
        let vm = KvmVm::new().unwrap();
        let mut cpu = vm.create_vcpu(0).unwrap();
        vm.save_state().unwrap();
        let error = cpu.save_state().unwrap_err();
        assert!(
            matches!(error, Error::ConfigureVcpu { operation: "save CPU state", ref source, .. }
            if source.kind() == io::ErrorKind::InvalidInput && source.to_string() == "invalid CPUID count")
        );
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_round_trips_with_guest_pmu_disabled() {
        for (clear_pmu, clear_pdcm) in [(true, false), (true, true), (false, true)] {
            let (platform, state) = {
                let vm = KvmVm::new().unwrap();
                let mut cpuid = vm.supported_cpuid().to_vec();
                for entry in &mut cpuid {
                    match entry.leaf {
                        1 if clear_pdcm => entry.ecx &= !(1 << 15),
                        0xa if clear_pmu => entry.eax &= !0xff,
                        7 if !entry.subleaf_required || entry.subleaf == 0 => {
                            entry.ecx &= !(1 << 7); // SHSTK is outside the snapshot contract.
                        }
                        _ => {}
                    }
                }
                let mut cpu = vm.create_vcpu(0).unwrap();
                cpu.set_cpu_features(&cpuid, &[]).unwrap();
                (vm.save_state().unwrap(), cpu.save_state().unwrap())
            };
            assert!(
                state.msrs.iter().all(|entry| entry.index != 0x345),
                "captured IA32_PERF_CAPABILITIES (clear_pmu={clear_pmu}, clear_pdcm={clear_pdcm})"
            );

            let vm = KvmVm::new().unwrap();
            vm.restore_before_vcpus(&platform).unwrap();
            let mut cpu = vm.create_vcpu(0).unwrap();
            cpu.restore_state(&state).unwrap();
            vm.restore_after_vcpus(&platform).unwrap();
        }
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_save_rejects_paged_32bit_pae() {
        const CR0_PE: u64 = 1;
        const CR0_PG: u64 = 1 << 31;
        const CR4_PAE: u64 = 1 << 5;
        const EFER_LMA: u64 = 1 << 10;

        let vm = KvmVm::new().unwrap();
        let mut cpu = snapshot_cpu(&vm);
        let mut sregs = cpu.fd.get_sregs().unwrap();
        sregs.cr0 |= CR0_PE | CR0_PG;
        sregs.cr4 |= CR4_PAE;
        sregs.efer &= !EFER_LMA;
        cpu.fd.set_sregs(&sregs).unwrap();
        vm.save_state().unwrap();

        let error = cpu.save_state().unwrap_err();
        assert!(
            matches!(error, Error::ConfigureVcpu { operation: "save CPU state", ref source, .. }
                if source.kind() == io::ErrorKind::Unsupported
                    && source.to_string() == "32-bit PAE paging state is unsupported because SREGS omits PDPTRs"),
            "{error:?}"
        );
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_xsave_probe_error_preflights_save_and_restore_without_blocking_run() {
        let vm = KvmVm::new().unwrap();
        let mut cpu = snapshot_cpu(&vm);
        vm.save_state().unwrap();
        let mut state = cpu.save_state().unwrap();
        let original = state.regs;
        state.regs.rax ^= 1;
        cpu.xsave_size = Err(CachedIoError::from_io(io::Error::from_raw_os_error(
            libc::EPERM,
        )));
        vm.save_state().unwrap();
        for error in [
            cpu.save_state().unwrap_err(),
            cpu.restore_state(&state).unwrap_err(),
        ] {
            assert!(matches!(error, Error::ConfigureVcpu { ref source, .. }
                if source.raw_os_error() == Some(libc::EPERM)));
        }
        assert!(!cpu.restore_started);
        assert_eq!(cpu.fd.get_regs().unwrap(), original);
        cpu.fd.set_kvm_immediate_exit(1);
        assert!(matches!(cpu.run().unwrap(), VcpuExit::Interrupted));
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_restore_rejects_unsupported_cpu_state_before_writes() {
        let vm = KvmVm::new().unwrap();
        let mut cpu = snapshot_cpu(&vm);
        let platform = vm.save_state().unwrap();
        let valid = cpu.save_state().unwrap();
        vm.restore_before_vcpus(&platform).unwrap();
        let mut shstk = valid.clone();
        shstk.cpuid = vec![kvm_bindings::kvm_cpuid_entry2 {
            function: 7,
            ecx: 1 << 7,
            ..Default::default()
        }];
        let mut pae = valid.clone();
        pae.sregs.cr0 |= 1 << 31;
        pae.sregs.cr4 |= 1 << 5;
        pae.sregs.efer &= !(1 << 10);
        let mut zero_frequency = valid.clone();
        zero_frequency.tsc_khz = 0;
        let mut excluded_msr = valid.clone();
        excluded_msr.msrs.push(kvm_msr_entry {
            index: 0x800,
            ..Default::default()
        });
        for (mut state, kind, message) in [
            (
                shstk,
                io::ErrorKind::Unsupported,
                "CET shadow stack (SHSTK) state cannot be snapshotted",
            ),
            (
                pae,
                io::ErrorKind::Unsupported,
                "32-bit PAE paging state is unsupported because SREGS omits PDPTRs",
            ),
            (
                zero_frequency,
                io::ErrorKind::InvalidInput,
                "TSC frequency must be nonzero",
            ),
            (
                excluded_msr,
                io::ErrorKind::InvalidInput,
                "MSR index 0x800 is excluded from snapshots",
            ),
        ] {
            state.regs.rax ^= 1;
            let error = cpu.restore_state(&state).unwrap_err();
            assert!(
                matches!(error, Error::ConfigureVcpu { operation: "restore CPU state", ref source, .. }
                if source.kind() == kind && source.to_string() == message),
                "{error:?}"
            );
            assert!(!cpu.restore_started);
            assert_eq!(cpu.fd.get_regs().unwrap(), valid.regs);
            assert_eq!(
                cpu.fd
                    .get_cpuid2(kvm_bindings::KVM_MAX_CPUID_ENTRIES)
                    .unwrap()
                    .as_slice(),
                valid.cpuid
            );
        }
        cpu.restore_state(&valid).unwrap();
        assert!(cpu.restore_started);
        let error = cpu.restore_state(&valid).unwrap_err();
        assert!(matches!(error, Error::ConfigureVcpu { ref source, .. }
            if source.kind() == io::ErrorKind::InvalidInput
                && source.to_string() == "restore requires a fresh, never-entered vCPU"));
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_restore_rejects_invalid_cpuid_before_writing_registers() {
        let vm = KvmVm::new().unwrap();
        let mut cpu = snapshot_cpu(&vm);
        vm.save_state().unwrap();
        let mut state = cpu.save_state().unwrap();
        let original = cpu.fd.get_regs().unwrap();
        let original_cpuid = state.cpuid.clone();
        state.regs.rax = original.rax ^ 1;
        for count in [0, kvm_bindings::KVM_MAX_CPUID_ENTRIES + 1] {
            state.cpuid.resize(count, original_cpuid[0]);
            let error = cpu.restore_state(&state).unwrap_err();
            assert!(matches!(error, Error::ConfigureVcpu { ref source, .. }
                if source.kind() == io::ErrorKind::InvalidInput
                    && source.to_string() == "invalid CPUID count"));
            assert_eq!(cpu.fd.get_regs().unwrap(), original);
            assert!(!cpu.restore_started);
            assert_eq!(
                cpu.fd
                    .get_cpuid2(kvm_bindings::KVM_MAX_CPUID_ENTRIES)
                    .unwrap()
                    .as_slice(),
                original_cpuid
            );
        }
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_restore_skips_set_xcrs_when_nr_xcrs_is_zero() {
        let vm = KvmVm::new().unwrap();
        let mut cpu = snapshot_cpu(&vm);
        vm.save_state().unwrap();
        let mut state = cpu.save_state().unwrap();
        state.xcrs.nr_xcrs = 0;
        state.xcrs.flags = 1;
        let original = cpu.fd.get_regs().unwrap();
        state.regs.rax = original.rax ^ 1;
        let error = cpu.restore_state(&state).unwrap_err();
        assert!(matches!(error, Error::ConfigureVcpu { ref source, .. }
            if source.kind() == io::ErrorKind::InvalidInput
                && source.to_string() == "invalid XSAVE/XCR snapshot shape"));
        assert_eq!(cpu.fd.get_regs().unwrap(), original);

        state.xcrs.flags = 0;
        cpu.restore_state(&state).unwrap();
        assert_eq!(cpu.fd.get_regs().unwrap(), state.regs);
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_restore_rejects_xsave_and_xcr_shapes_before_writing_registers() {
        let vm = KvmVm::new().unwrap();
        let mut cpu = snapshot_cpu(&vm);
        vm.save_state().unwrap();
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
        let vm = KvmVm::new().unwrap();
        let mut cpu = snapshot_cpu(&vm);
        vm.save_state().unwrap();
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
            MAX_SNAPSHOT_MSR_ENTRIES,
        ] {
            // Failed restores are not transactional: use a fresh destination
            // for each boundary and report all failures, not just the first.
            let vm = KvmVm::new().unwrap();
            let mut cpu = snapshot_cpu(&vm);
            vm.save_state().unwrap();
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
            vm.save_state().unwrap();
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
        let vm = KvmVm::new().unwrap();
        let mut cpu = snapshot_cpu(&vm);
        vm.save_state().unwrap();
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
                assert_eq!(get_tsc_khz(&cpu.fd).unwrap(), state.tsc_khz);
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

    const MSR_MTRR_DEF_TYPE: u32 = 0x2ff;

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_restore_reports_the_first_rejected_msr() {
        let vm = KvmVm::new().unwrap();
        let mut cpu = snapshot_cpu(&vm);
        vm.save_state().unwrap();
        let mut state = cpu.save_state().unwrap();
        state.msrs = vec![kvm_bindings::kvm_msr_entry {
            index: MSR_MTRR_DEF_TYPE,
            data: u64::MAX,
            ..Default::default()
        }];
        let error = cpu.restore_state(&state).unwrap_err();
        assert!(
            matches!(error, Error::ConfigureVcpu { operation: "restore CPU state", ref source, .. }
            if source.to_string() == "KVM wrote 0 of 1 MSRs; first rejected index 0x2ff")
        );
        assert!(cpu.restore_started);
        state.msrs.clear();
        let error = cpu.restore_state(&state).unwrap_err();
        assert!(matches!(error, Error::ConfigureVcpu { ref source, .. }
            if source.kind() == io::ErrorKind::InvalidInput
                && source.to_string() == "restore requires a fresh, never-entered vCPU"));
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_restore_reports_first_rejected_msr_in_second_batch() {
        const FS_BASE: u32 = 0xc000_0100;
        const KERNEL_GS_BASE: u32 = 0xc000_0102;
        let vm = KvmVm::new().unwrap();
        let mut cpu = snapshot_cpu(&vm);
        vm.save_state().unwrap();
        let mut state = cpu.save_state().unwrap();
        state.msrs = (1..=(MAX_MSR_BATCH_ENTRIES + 2))
            .map(|data| kvm_msr_entry {
                index: KERNEL_GS_BASE,
                data: data as u64,
                ..Default::default()
            })
            .collect();
        state.msrs[MAX_MSR_BATCH_ENTRIES + 1].index = FS_BASE;
        state.msrs.push(kvm_msr_entry {
            index: MSR_MTRR_DEF_TYPE,
            data: u64::MAX,
            ..Default::default()
        });
        let error = cpu.restore_state(&state).unwrap_err();
        assert!(
            matches!(error, Error::ConfigureVcpu { operation: "restore CPU state", ref source, .. }
            if source.to_string() == "KVM wrote 2 of 3 MSRs; first rejected index 0x2ff")
        );
        let actual = snapshot_msrs(&cpu.fd, &[KERNEL_GS_BASE, FS_BASE]).unwrap();
        assert_eq!(actual, state.msrs[MAX_MSR_BATCH_ENTRIES..][..2]);
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_vcpus_share_the_kvm_advertised_msr_index_cache() {
        let vm = KvmVm::new().unwrap();
        let first = vm.create_vcpu(0).unwrap();
        let indices = Arc::clone(first.fd.snapshot.msr_indices().unwrap());
        // One worker owns at most one reserved kick signal at a time.
        drop(first);
        let second = vm.create_vcpu(1).unwrap();
        let advertised = kvm_msr_index_list(&kvm_ioctls::Kvm::new().unwrap()).unwrap();
        assert_eq!(indices, build_snapshot_msr_indices(&advertised));
        assert!(Arc::ptr_eq(
            &indices,
            second.fd.snapshot.msr_indices().unwrap()
        ));
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_legacy_xsave_capture_uses_the_fixed_region() {
        let vm = KvmVm::new().unwrap();
        let mut cpu = snapshot_cpu(&vm);
        // Exercise the pre-XSAVE2 fallback on an XSAVE2-capable host too.
        // GET_XSAVE is always the fixed-size ioctl; do not issue SET_XSAVE2
        // with a buffer smaller than the real destination's capability.
        cpu.xsave_size = Ok(0);
        let fixed = cpu.fd.get_xsave().unwrap();
        vm.save_state().unwrap();
        let state = cpu.save_state().unwrap();
        assert_eq!(state.xsave.len(), XSAVE_REGION_WORDS);
        assert_eq!(state.xsave, fixed.region);
        for extra_bytes in [1, 4, 5] {
            let xsave_size = size_of::<kvm_bindings::kvm_xsave>() + extra_bytes;
            assert_eq!(
                KvmVcpu::xsave_buffer(xsave_size).unwrap().as_slice().len(),
                extra_bytes.div_ceil(4)
            );
        }
    }

    #[test]
    #[ignore = "requires Linux x86_64 with access to /dev/kvm"]
    fn snapshot_round_trips_tsc_via_msr_without_offset_controls() {
        use std::time::Instant;

        let vm = KvmVm::new().unwrap();
        let mut cpu = snapshot_cpu(&vm);
        cpu.tsc_offset = Some(false);
        cpu.write_msr_batches(&[kvm_msr_entry {
            index: MSR_IA32_TSC,
            data: 1 << 40,
            ..Default::default()
        }])
        .unwrap();
        let read_tsc = |cpu: &KvmVcpu| snapshot_msrs(&cpu.fd, &[MSR_IA32_TSC]).unwrap()[0].data;
        let platform = vm.save_state().unwrap();
        let before = read_tsc(&cpu);
        let state = cpu.save_state().unwrap();
        let error = cpu.save_state().unwrap_err();
        assert!(
            matches!(error, Error::ConfigureVcpu { operation: "save CPU state", ref source, .. }
            if source.to_string() == "save VM state before recapturing vCPU state")
        );
        let saved_tsc = state
            .msrs
            .iter()
            .find(|entry| entry.index == MSR_IA32_TSC)
            .unwrap()
            .data;
        assert!((before..=read_tsc(&cpu)).contains(&saved_tsc));
        drop(cpu);

        let vm = KvmVm::new().unwrap();
        vm.restore_before_vcpus(&platform).unwrap();
        let mut cpu = vm.create_vcpu(0).unwrap();
        cpu.tsc_offset = Some(false);
        let before_restore = Instant::now();
        cpu.restore_state(&state).unwrap();
        let restored_tsc = read_tsc(&cpu);
        let elapsed = before_restore.elapsed() + std::time::Duration::from_millis(5);
        let max_cycles = ns_to_tsc_cycles(elapsed.as_nanos() as u64, state.tsc_khz);
        assert!(restored_tsc.wrapping_sub(saved_tsc) <= max_cycles);
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
