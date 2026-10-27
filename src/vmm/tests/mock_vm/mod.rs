// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! A mock hypervisor backend that records memory registrations, interrupt
//! line changes and vCPU setup, runs each vCPU through a script, and can be
//! told to fail, so the VMM's lifetime rules, interrupt path and vCPU
//! lifecycle are testable without a host VM.

use std::{
    collections::VecDeque,
    io,
    sync::{Arc, Condvar, Mutex},
};

use boxlite_hypervisor::{Error, MemoryRegion, Result, Vcpu, VcpuExit, VcpuHandle, Vm};

/// One recorded backend call, with the host address as an integer because
/// `MemoryRegion` is not `Send`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

/// Records every map, unmap and interrupt line change, and fails the calls
/// whose zero-based index (all calls counted together) was selected. A
/// failed unmap keeps the registration, as KVM does.
#[derive(Debug, Default)]
pub(crate) struct MockVm {
    log: Arc<Mutex<Vec<Call>>>,
    fail_at: Vec<usize>,
    /// The script of each vCPU, by id; a missing one waits for a kick.
    scripts: Vec<Vec<Step>>,
    /// The vCPU whose `set_cpu_features` fails.
    fail_setup: Option<u32>,
    /// The id of each vCPU entry into the guest, in order.
    entries: Arc<Mutex<Vec<u32>>>,
}

impl MockVm {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn failing_at(call_indexes: &[usize]) -> Self {
        Self {
            fail_at: call_indexes.to_vec(),
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

    /// The call log, which outlives the backend so tests can read it after a drop.
    pub(crate) fn log(&self) -> Arc<Mutex<Vec<Call>>> {
        Arc::clone(&self.log)
    }

    pub(crate) fn calls(&self) -> Vec<Call> {
        self.log.lock().unwrap().clone()
    }

    fn record(&self, call: Call) -> Result<()> {
        let mut log = self.log.lock().unwrap();
        let index = log.len();
        log.push(call);
        if !self.fail_at.contains(&index) {
            return Ok(());
        }
        let source = io::Error::from(io::ErrorKind::OutOfMemory);
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
            Call::SetCpuFeatures { .. } | Call::SetBootRegisters { .. } | Call::DropVcpu { .. } => {
                unreachable!("only memory and interrupt calls fail by index")
            }
        })
    }
}

impl Vm for MockVm {
    type Vcpu = MockVcpu;

    unsafe fn map_memory(&self, region: &MemoryRegion) -> Result<()> {
        self.record(Call::map(region))
    }

    fn unmap_memory(&self, region: &MemoryRegion) -> Result<()> {
        self.record(Call::unmap(region))
    }

    fn create_vcpu(&self, id: u32) -> Result<MockVcpu> {
        let steps = self.scripts.get(id as usize).cloned().unwrap_or_default();
        Ok(MockVcpu {
            id,
            steps: steps.into(),
            log: Arc::clone(&self.log),
            fail_setup: self.fail_setup == Some(id),
            entries: Arc::clone(&self.entries),
            kick: Arc::default(),
            data: [0],
        })
    }

    fn set_irq_line(&self, line: u32, level: bool) -> Result<()> {
        self.record(Call::SetIrqLine { line, level })
    }
}

pub(crate) struct MockVcpu {
    id: u32,
    steps: VecDeque<Step>,
    log: Arc<Mutex<Vec<Call>>>,
    fail_setup: bool,
    entries: Arc<Mutex<Vec<u32>>>,
    kick: Arc<Kick>,
    data: [u8; 1],
}

impl MockVcpu {
    fn record(&self, call: Call) {
        self.log.lock().unwrap().push(call);
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
                self.data = [byte];
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

    fn complete_pending_io(&mut self) -> Result<()> {
        Ok(())
    }

    fn handle(&self) -> MockHandle {
        MockHandle(Arc::clone(&self.kick))
    }
}

#[cfg(target_arch = "x86_64")]
impl boxlite_hypervisor::X86Vm for MockVm {
    fn supported_cpuid(&self) -> &[boxlite_hypervisor::X86CpuidEntry] {
        &[]
    }
}

#[cfg(target_arch = "x86_64")]
impl boxlite_hypervisor::X86Vcpu for MockVcpu {
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
