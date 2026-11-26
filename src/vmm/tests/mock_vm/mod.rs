// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! A mock hypervisor backend that records memory, interrupt and vCPU call
//! attempts, tracks memory registrations, and runs scripted vCPUs. Tests can
//! inject failures without a host VM.

use std::{
    collections::{HashSet, VecDeque},
    io,
    sync::{Arc, Condvar, Mutex},
};

use boxlite_hypervisor::{
    Error, IoCompletion, MemoryRegion, Result, Vcpu, VcpuExit, VcpuHandle, Vm,
};

#[cfg(target_arch = "x86_64")]
use std::sync::mpsc;

#[cfg(target_arch = "x86_64")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CpuOperation {
    CheckParkingSupport,
    Reset,
    Bind,
    ObservePark,
}

#[cfg(target_arch = "x86_64")]
#[derive(Debug)]
pub(crate) struct CpuPause {
    id: u32,
    operation: CpuOperation,
    entered: mpsc::SyncSender<()>,
    resume: Mutex<mpsc::Receiver<()>>,
}

#[cfg(target_arch = "x86_64")]
impl CpuPause {
    pub(crate) fn new(
        id: u32,
        operation: CpuOperation,
    ) -> (Arc<Self>, mpsc::Receiver<()>, mpsc::SyncSender<()>) {
        let (entered, wait) = mpsc::sync_channel(1);
        let (release, resume) = mpsc::sync_channel(1);
        (
            Arc::new(Self {
                id,
                operation,
                entered,
                resume: Mutex::new(resume),
            }),
            wait,
            release,
        )
    }

    fn pause(&self, id: u32, operation: CpuOperation) {
        if (self.id, self.operation) == (id, operation) {
            let _ = self.entered.send(());
            let _ = self.resume.lock().unwrap().recv();
        }
    }
}

/// One recorded call attempt, with the host address as an integer because
/// `MemoryRegion` is not `Send`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Call {
    Map {
        guest_addr: u64,
        host_addr: usize,
        size: usize,
    },
    Unmap {
        guest_addr: u64,
        host_addr: usize,
        size: usize,
    },
    SetIrqLine {
        line: u32,
        level: bool,
    },
    SetCpuFeatures {
        id: u32,
    },
    SetBootRegisters {
        id: u32,
    },
    DropVcpu {
        id: u32,
    },
    ParkVcpu {
        id: u32,
    },
    ResetVcpu {
        id: u32,
    },
    ResumeVcpu {
        id: u32,
    },
}

/// One exit of a scripted mock vCPU. A vCPU whose script has run out waits
/// for a kick, like a guest that never exits on its own.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Step {
    /// A one-byte MMIO write of `byte` at `addr`.
    Write {
        addr: u64,
        byte: u8,
    },
    /// A four-byte MMIO write of `value` at `addr`, as a virtio-mmio driver
    /// writes its control registers.
    Write32 {
        addr: u64,
        value: u32,
    },
    Shutdown,
    Reset,
    Halted,
    /// `run` fails with `RunVcpu`.
    Fail,
}

impl Call {
    pub(crate) fn map(region: &MemoryRegion) -> Self {
        Self::Map {
            guest_addr: region.guest_addr,
            host_addr: region.host_addr.as_ptr() as usize,
            size: region.size,
        }
    }

    pub(crate) fn unmap(region: &MemoryRegion) -> Self {
        Self::Unmap {
            guest_addr: region.guest_addr,
            host_addr: region.host_addr.as_ptr() as usize,
            size: region.size,
        }
    }
}

/// The (guest address, host address, size) passed to `unmap_memory`.
pub(crate) type UnmapAttempt = (u64, usize, usize);

/// The attempt log and its ioctl subset, shared by the VM and its vCPUs.
#[derive(Debug, Default)]
pub(crate) struct CallLog {
    attempts: Arc<Mutex<Vec<Call>>>,
    /// One flag per attempt. Always lock `attempts` before `ioctl`.
    ioctl: Mutex<Vec<bool>>,
}

impl CallLog {
    fn record(&self, call: Call, reaches_ioctl: bool) -> usize {
        let mut attempts = self.attempts.lock().unwrap();
        let index = attempts.len();
        attempts.push(call);
        self.ioctl.lock().unwrap().push(reaches_ioctl);
        index
    }

    /// The attempts that reach the backend, in log order, including failures.
    pub(crate) fn ioctl_calls(&self) -> Vec<Call> {
        let attempts = self.attempts.lock().unwrap();
        let ioctl = self.ioctl.lock().unwrap();
        attempts
            .iter()
            .copied()
            .zip(ioctl.iter().copied())
            .filter_map(|(call, reaches_ioctl)| reaches_ioctl.then_some(call))
            .collect()
    }
}

/// Records all call attempts. Memory and interrupt failures are injected by
/// index in that log. As in KVM, unmapping an unregistered region is a no-op
/// unless a failure is injected, and a failed unmap keeps any existing registration.
#[derive(Debug, Default)]
pub(crate) struct MockVm {
    log: Arc<CallLog>,
    unmap_attempts: Arc<Mutex<Vec<UnmapAttempt>>>,
    registrations: Mutex<HashSet<Call>>,
    fail_at: Vec<(usize, io::ErrorKind)>,
    /// The script of each vCPU, by id; a missing one waits for a kick.
    scripts: Vec<Vec<Step>>,
    /// The vCPU whose `set_cpu_features` fails.
    fail_setup: Option<u32>,
    #[cfg(target_arch = "x86_64")]
    fail_reset: Option<u32>,
    #[cfg(target_arch = "x86_64")]
    fail_reset_read_once: Option<u32>,
    #[cfg(target_arch = "x86_64")]
    pause: Option<Arc<CpuPause>>,
    /// The id of each vCPU entry into the guest, in order.
    entries: Arc<Mutex<Vec<u32>>>,
}

impl MockVm {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Injects out-of-memory errors at the given attempt-log indices.
    pub(crate) fn failing_at(call_indexes: &[usize]) -> Self {
        Self {
            fail_at: call_indexes
                .iter()
                .map(|&index| (index, io::ErrorKind::OutOfMemory))
                .collect(),
            ..Self::default()
        }
    }

    /// Injects the given errors at their attempt-log indices.
    pub(crate) fn failing_with(fail_at: &[(usize, io::ErrorKind)]) -> Self {
        Self {
            fail_at: fail_at.to_vec(),
            ..Self::default()
        }
    }

    pub(crate) fn with_scripts(scripts: Vec<Vec<Step>>) -> Self {
        Self {
            scripts,
            ..Self::default()
        }
    }

    pub(crate) fn failing_setup_of(id: u32) -> Self {
        Self {
            fail_setup: Some(id),
            ..Self::default()
        }
    }

    #[cfg(target_arch = "x86_64")]
    pub(crate) fn failing_reset_of(id: u32) -> Self {
        Self {
            fail_reset: Some(id),
            ..Self::default()
        }
    }

    #[cfg(target_arch = "x86_64")]
    pub(crate) fn failing_reset_read_once_of(id: u32) -> Self {
        Self {
            fail_reset_read_once: Some(id),
            ..Self::default()
        }
    }

    #[cfg(target_arch = "x86_64")]
    pub(crate) fn with_cpu_pause(mut self, pause: Arc<CpuPause>) -> Self {
        self.pause = Some(pause);
        self
    }

    /// Also fails the setup of vCPU `id`, on top of the scripts.
    pub(crate) fn and_failing_setup_of(self, id: u32) -> Self {
        Self {
            fail_setup: Some(id),
            ..self
        }
    }

    /// Every guest entry, which outlives the backend like the call log.
    pub(crate) fn entries(&self) -> Arc<Mutex<Vec<u32>>> {
        Arc::clone(&self.entries)
    }

    /// All call attempts, retained after the backend drops. Tests only read this log.
    pub(crate) fn log(&self) -> Arc<Mutex<Vec<Call>>> {
        Arc::clone(&self.log.attempts)
    }

    /// A snapshot of all attempts, including unmaps of unregistered regions.
    pub(crate) fn calls(&self) -> Vec<Call> {
        self.log.attempts.lock().unwrap().clone()
    }

    /// Attempts that reach the backend: all maps and non-memory calls, and
    /// only unmaps of regions that were registered at the time of the call.
    pub(crate) fn ioctl_calls(&self) -> Vec<Call> {
        self.log.ioctl_calls()
    }

    /// A handle for reading the ioctl subset even after the backend drops.
    pub(crate) fn call_log(&self) -> Arc<CallLog> {
        Arc::clone(&self.log)
    }

    /// The arguments of every unmap attempt, including no-ops and failures.
    pub(crate) fn unmap_attempts(&self) -> Vec<UnmapAttempt> {
        self.unmap_attempts.lock().unwrap().clone()
    }

    /// The memory regions currently registered with the backend.
    pub(crate) fn registrations(&self) -> HashSet<Call> {
        self.registrations.lock().unwrap().clone()
    }

    fn record(&self, call: Call, reaches_ioctl: bool) -> Result<()> {
        let index = self.log.record(call, reaches_ioctl);
        let Some(&(_, kind)) = self.fail_at.iter().find(|&&(at, _)| at == index) else {
            return Ok(());
        };
        let source = io::Error::from(kind);
        Err(match call {
            Call::Map {
                guest_addr, size, ..
            } => Error::MapMemory {
                guest_addr,
                size,
                source,
            },
            Call::Unmap {
                guest_addr, size, ..
            } => Error::UnmapMemory {
                guest_addr,
                size,
                source,
            },
            Call::SetIrqLine { line, .. } => Error::SetIrqLine { line, source },
            Call::SetCpuFeatures { .. }
            | Call::SetBootRegisters { .. }
            | Call::DropVcpu { .. }
            | Call::ParkVcpu { .. }
            | Call::ResetVcpu { .. }
            | Call::ResumeVcpu { .. } => {
                unreachable!("only memory and interrupt calls fail by index")
            }
        })
    }
}

impl Vm for MockVm {
    type Vcpu = MockVcpu;

    unsafe fn map_memory(&self, region: &MemoryRegion) -> Result<()> {
        let mut registrations = self.registrations.lock().unwrap();
        let call = Call::map(region);
        self.record(call, true)?;
        if !registrations.insert(call) {
            return Err(Error::MapMemory {
                guest_addr: region.guest_addr,
                size: region.size,
                source: io::ErrorKind::AlreadyExists.into(),
            });
        }
        Ok(())
    }

    fn unmap_memory(&self, region: &MemoryRegion) -> Result<()> {
        self.unmap_attempts.lock().unwrap().push((
            region.guest_addr,
            region.host_addr.as_ptr() as usize,
            region.size,
        ));
        let mut registrations = self.registrations.lock().unwrap();
        let registration = Call::map(region);
        let registered = registrations.contains(&registration);
        self.record(Call::unmap(region), registered)?;
        if registered {
            registrations.remove(&registration);
        }
        Ok(())
    }

    fn create_vcpu(&self, id: u32) -> Result<MockVcpu> {
        let steps = self.scripts.get(id as usize).cloned().unwrap_or_default();
        Ok(MockVcpu {
            id,
            steps: steps.into(),
            log: Arc::clone(&self.log),
            fail_setup: self.fail_setup == Some(id),
            #[cfg(target_arch = "x86_64")]
            fail_reset: self.fail_reset == Some(id),
            #[cfg(target_arch = "x86_64")]
            fail_reset_read_once: self.fail_reset_read_once == Some(id),
            #[cfg(target_arch = "x86_64")]
            pause: self.pause.clone(),
            entries: Arc::clone(&self.entries),
            kick: Arc::default(),
            data: [0; 4],
        })
    }

    fn set_irq_line(&self, line: u32, level: bool) -> Result<()> {
        self.record(Call::SetIrqLine { line, level }, true)
    }
}

pub(crate) struct MockVcpu {
    id: u32,
    steps: VecDeque<Step>,
    log: Arc<CallLog>,
    fail_setup: bool,
    #[cfg(target_arch = "x86_64")]
    fail_reset: bool,
    #[cfg(target_arch = "x86_64")]
    fail_reset_read_once: bool,
    #[cfg(target_arch = "x86_64")]
    pause: Option<Arc<CpuPause>>,
    entries: Arc<Mutex<Vec<u32>>>,
    kick: Arc<Kick>,
    data: [u8; 4],
}

impl MockVcpu {
    fn record(&self, call: Call) {
        self.log.record(call, true);
    }
}

impl Drop for MockVcpu {
    fn drop(&mut self) {
        self.record(Call::DropVcpu { id: self.id });
    }
}

/// A kick that is pending until the next `run` consumes it.
#[derive(Debug, Default)]
pub(crate) struct Kick {
    pending: Mutex<bool>,
    changed: Condvar,
}

#[derive(Clone)]
pub(crate) struct MockHandle(Arc<Kick>);

impl VcpuHandle for MockHandle {
    fn kick(&self) -> Result<()> {
        *self.0.pending.lock().unwrap() = true;
        self.0.changed.notify_all();
        Ok(())
    }
}

impl Vcpu for MockVcpu {
    type Handle = MockHandle;

    fn run(&mut self) -> Result<VcpuExit<'_>> {
        let id = self.id;
        self.entries.lock().unwrap().push(id);
        Ok(match self.steps.pop_front() {
            Some(Step::Write { addr, byte }) => {
                self.data[0] = byte;
                VcpuExit::MmioWrite {
                    guest_addr: addr,
                    bytes: &self.data[..1],
                }
            }
            Some(Step::Write32 { addr, value }) => {
                self.data = value.to_le_bytes();
                VcpuExit::MmioWrite {
                    guest_addr: addr,
                    bytes: &self.data,
                }
            }
            Some(Step::Shutdown) => VcpuExit::Shutdown,
            Some(Step::Reset) => VcpuExit::Reset,
            Some(Step::Halted) => VcpuExit::Halted,
            Some(Step::Fail) => {
                let source = io::Error::from(io::ErrorKind::Other);
                return Err(Error::RunVcpu { id, source });
            }
            None => {
                let pending = self.kick.pending.lock().unwrap();
                let mut pending = self
                    .kick
                    .changed
                    .wait_while(pending, |kicked| !*kicked)
                    .unwrap();
                *pending = false;
                VcpuExit::Interrupted
            }
        })
    }

    fn complete_pending_io(&mut self) -> Result<IoCompletion<'_>> {
        Ok(IoCompletion::Done)
    }

    fn handle(&self) -> MockHandle {
        MockHandle(Arc::clone(&self.kick))
    }
}

#[cfg(target_arch = "x86_64")]
impl boxlite_hypervisor::X86Vm for MockVm {
    fn supports_vcpu_parking(&self) -> bool {
        if let Some(pause) = &self.pause {
            pause.pause(0, CpuOperation::CheckParkingSupport);
        }
        true
    }

    fn supported_cpuid(&self) -> &[boxlite_hypervisor::X86CpuidEntry] {
        &[]
    }
}

#[cfg(target_arch = "x86_64")]
impl boxlite_hypervisor::X86Vcpu for MockVcpu {
    fn detach(self) -> boxlite_hypervisor::VcpuDetach<Self> {
        self.record(Call::ParkVcpu { id: self.id });
        Ok(Box::new(ParkedMockVcpu(self)))
    }

    fn set_cpu_features(
        &mut self,
        _cpuid: &[boxlite_hypervisor::X86CpuidEntry],
        _msrs: &[boxlite_hypervisor::X86Msr],
    ) -> Result<()> {
        self.record(Call::SetCpuFeatures { id: self.id });
        if self.fail_setup {
            let source = io::Error::from(io::ErrorKind::InvalidInput);
            let (id, operation) = (self.id, "set CPUID");
            return Err(Error::ConfigureVcpu {
                id,
                operation,
                source,
            });
        }
        Ok(())
    }

    fn set_boot_registers(&mut self, _state: &boxlite_hypervisor::X86BootRegisters) -> Result<()> {
        self.record(Call::SetBootRegisters { id: self.id });
        Ok(())
    }
}

/// A parked mock vCPU; it keeps its script and kick state for the next resume.
#[cfg(target_arch = "x86_64")]
pub(crate) struct ParkedMockVcpu(MockVcpu);

#[cfg(target_arch = "x86_64")]
impl boxlite_hypervisor::X86DetachedVcpu for ParkedMockVcpu {
    type Vcpu = MockVcpu;

    fn is_halted(&self) -> Result<bool> {
        if let Some(pause) = &self.0.pause {
            pause.pause(self.0.id, CpuOperation::ObservePark);
        }
        Ok(true)
    }

    fn reset(&mut self) -> std::result::Result<(), boxlite_hypervisor::VcpuResetError> {
        self.0.record(Call::ResetVcpu { id: self.0.id });
        if let Some(pause) = &self.0.pause {
            pause.pause(self.0.id, CpuOperation::Reset);
        }
        if std::mem::take(&mut self.0.fail_reset_read_once) {
            return Err(boxlite_hypervisor::VcpuResetError::Unchanged(
                Error::ConfigureVcpu {
                    id: self.0.id,
                    operation: "read vCPU events",
                    source: io::ErrorKind::Interrupted.into(),
                },
            ));
        }
        if self.0.fail_reset {
            return Err(boxlite_hypervisor::VcpuResetError::Unavailable(
                Error::ConfigureVcpu {
                    id: self.0.id,
                    operation: "reset",
                    source: io::ErrorKind::InvalidInput.into(),
                },
            ));
        }
        Ok(())
    }

    fn bind(self: Box<Self>) -> Result<MockVcpu> {
        self.0.record(Call::ResumeVcpu { id: self.0.id });
        if let Some(pause) = &self.0.pause {
            pause.pause(self.0.id, CpuOperation::Bind);
        }
        Ok(self.0)
    }
}
