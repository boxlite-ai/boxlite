// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! A fake hypervisor backend that records memory registrations and can be
//! told to fail, so the VMM's lifetime rules are testable without a host VM.

use std::{
    io,
    sync::{Arc, Mutex},
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

/// Records every map and unmap and fails the calls whose zero-based index
/// (map and unmap counted together) was selected. A failed unmap keeps the
/// registration, as KVM does.
#[derive(Debug, Default)]
pub(crate) struct FakeVm {
    log: Arc<Mutex<Vec<Call>>>,
    fail_at: Vec<usize>,
}

impl FakeVm {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn failing_at(call_indexes: &[usize]) -> Self {
        Self {
            fail_at: call_indexes.to_vec(),
            ..Self::default()
        }
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
        })
    }
}

impl Vm for FakeVm {
    type Vcpu = FakeVcpu;

    unsafe fn map_memory(&self, region: &MemoryRegion) -> Result<()> {
        self.record(Call::map(region))
    }

    fn unmap_memory(&self, region: &MemoryRegion) -> Result<()> {
        self.record(Call::unmap(region))
    }

    fn create_vcpu(&self, _id: u32) -> Result<FakeVcpu> {
        Ok(FakeVcpu)
    }

    fn set_irq_line(&self, _line: u32, _level: bool) -> Result<()> {
        Ok(())
    }
}

pub(crate) struct FakeVcpu;

#[derive(Clone)]
pub(crate) struct FakeHandle;

impl VcpuHandle for FakeHandle {
    fn kick(&self) -> Result<()> {
        Ok(())
    }
}

impl Vcpu for FakeVcpu {
    type Handle = FakeHandle;

    fn run(&mut self) -> Result<VcpuExit<'_>> {
        Ok(VcpuExit::Halted)
    }

    fn complete_pending_io(&mut self) -> Result<()> {
        Ok(())
    }

    fn handle(&self) -> FakeHandle {
        FakeHandle
    }
}
