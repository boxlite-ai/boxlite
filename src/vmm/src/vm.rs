// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The VM facade: configuration, host VM creation and RAM registration.

use boxlite_hypervisor::Vm as HostVm;

use crate::{
    config::VmConfig,
    error::{Error, Result},
    memory::{GuestRam, ram_ranges},
};

pub(crate) enum VmExit {
    StopRequested,
    GuestShutdown,
    GuestReset,
}

/// The guest machine on host backend `H`.
pub(crate) struct Vm<H: HostVm> {
    // Field order is load-bearing: the host VM drops, releasing its guest
    // mappings, before the RAM that backs them.
    backend: H,
    ram: GuestRam,
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
impl Vm<boxlite_hypervisor::KvmVm> {
    /// Validates `config`, creates the KVM VM and registers its RAM.
    pub(crate) fn new(config: VmConfig) -> Result<Self> {
        Self::with_backend(config, boxlite_hypervisor::KvmVm::new)
    }
}

impl<H: HostVm> Vm<H> {
    /// Validates `config`, allocates the RAM layout, creates the host VM with
    /// `host_vm`, then registers every RAM range. Invalid configuration fails
    /// before `host_vm` runs; tests pass a fake backend.
    pub(crate) fn with_backend(
        config: VmConfig,
        host_vm: impl FnOnce() -> boxlite_hypervisor::Result<H>,
    ) -> Result<Self> {
        config.validate()?;
        // Allocating first keeps the drop order safe on every early return:
        // locals drop in reverse order, so the host VM goes before the RAM.
        let mut ram = GuestRam::new(&ram_ranges(config.memory_mib))?;
        let backend = host_vm()?;
        ram.map(&backend)?;
        Ok(Self { backend, ram })
    }

    #[expect(unreachable_code, clippy::diverging_sub_expression)]
    pub(crate) fn run(&mut self) -> Result<VmExit> {
        // Device workers process their own queues, so every event that
        // reaches this thread ends the VM.
        enum Event {
            StopRequested,
            VcpuExited(Result<VmExit>),
            DeviceFailed(Error),
        }

        let _event: Result<Event> = todo!("wait for the first terminal VM event");
        let _outcome = match _event {
            Ok(Event::StopRequested) => Ok(VmExit::StopRequested),
            Ok(Event::VcpuExited(outcome)) => outcome,
            Ok(Event::DeviceFailed(error)) | Err(error) => Err(error),
        };
        let joined: Result<()> = todo!("stop and join the vCPU and device worker threads");
        _outcome.and_then(|exit| joined.map(|()| exit))
    }
}

impl<H: HostVm> Drop for Vm<H> {
    fn drop(&mut self) {
        // A VM that never ran still holds its registrations. Remove them so
        // the backing can be released; `GuestRam` leaks it on failure.
        let _ = self.ram.unmap(&self.backend);
    }
}

// The file lives under `tests/` so the suite stays out of the crate's counted
// source; it is still a unit-test module with access to crate-private items.
#[cfg(test)]
#[path = "../tests/vm/mod.rs"]
mod tests;
