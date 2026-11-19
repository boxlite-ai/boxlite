// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Parked KVM vCPUs: a vCPU the host has not granted keeps its descriptor but
//! has no worker thread, so no thread can enter the guest on its behalf.
//!
//! KVM still accepts INIT and SIPI for a parked vCPU and latches them; a
//! thread that later resumes it would run from that stale SIPI vector.
//! [`ParkedKvmVcpu::reset`] drops them first.

use kvm_bindings::{KVM_MP_STATE_HALTED, KVM_MP_STATE_UNINITIALIZED, KVM_VCPUEVENT_VALID_SMM};
use kvm_ioctls::VcpuFd;
use std::os::fd::AsRawFd;

use super::{KvmVcpu, kick::WorkerSignal};
use crate::{Error, Result};

/// A KVM vCPU with no worker thread. It can move to the thread that resumes it.
#[derive(Debug)]
pub struct ParkedKvmVcpu {
    fd: VcpuFd,
    id: u32,
    run_size: usize,
    signal: i32,
}

impl ParkedKvmVcpu {
    fn failure(&self, operation: &'static str) -> impl Fn(kvm_ioctls::Error) -> Error + '_ {
        move |source| Error::ConfigureVcpu {
            id: self.id,
            operation,
            source: source.into(),
        }
    }

    /// Whether the guest left the vCPU halted, as Linux leaves an offlined CPU.
    pub fn is_halted(&self) -> Result<bool> {
        let state = self
            .fd
            .get_mp_state()
            .map_err(self.failure("read MP state"))?;
        Ok(state.mp_state == KVM_MP_STATE_HALTED)
    }

    /// Clears a latched INIT, then returns the vCPU to waiting for INIT, which
    /// also drops a pending SIPI: KVM accepts a SIPI only after an INIT.
    pub fn reset(&mut self) -> Result<()> {
        let mut events = self
            .fd
            .get_vcpu_events()
            .map_err(self.failure("read vCPU events"))?;
        // Only the SMM group carries the latched INIT; the rest stays as read.
        events.flags = KVM_VCPUEVENT_VALID_SMM;
        events.smi.latched_init = 0;
        self.fd
            .set_vcpu_events(&events)
            .map_err(self.failure("clear latched INIT"))?;
        let mut state = self
            .fd
            .get_mp_state()
            .map_err(self.failure("read MP state"))?;
        state.mp_state = KVM_MP_STATE_UNINITIALIZED;
        self.fd
            .set_mp_state(state)
            .map_err(self.failure("wait for INIT"))
    }

    /// Reserves the kick signal on the calling thread and binds the vCPU to it.
    pub fn resume(self) -> Result<KvmVcpu> {
        let bind = || {
            let kick = WorkerSignal::reserve(self.id, self.signal)?;
            kick.configure(self.fd.as_raw_fd())?;
            Ok(kick)
        };
        let kick = bind().map_err(|source| Error::CreateVcpu {
            id: self.id,
            source,
        })?;
        Ok(KvmVcpu::new(self.fd, self.id, self.run_size, kick))
    }
}

impl crate::X86ParkVcpu for KvmVcpu {
    type Parked = ParkedKvmVcpu;

    fn park(self) -> Result<ParkedKvmVcpu> {
        let (fd, id, run_size, signal) = self.into_parts()?;
        Ok(ParkedKvmVcpu {
            fd,
            id,
            run_size,
            signal,
        })
    }
}

impl crate::X86ParkedVcpu for ParkedKvmVcpu {
    type Vcpu = KvmVcpu;

    fn is_halted(&self) -> Result<bool> {
        Self::is_halted(self)
    }

    fn reset(&mut self) -> Result<()> {
        Self::reset(self)
    }

    fn resume(self) -> Result<KvmVcpu> {
        Self::resume(self)
    }
}

// The suite lives under `tests/` so it stays out of the crate's counted source;
// it is still a unit-test module with access to crate-private items.
#[cfg(test)]
#[path = "../../tests/kvm_park/mod.rs"]
mod tests;
