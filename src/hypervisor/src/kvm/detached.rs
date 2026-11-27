// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Parked KVM vCPUs: a vCPU the host has not granted keeps its descriptor but
//! has no worker thread, so no thread can enter the guest on its behalf.
//!
//! KVM still accepts INIT and SIPI for a parked vCPU and latches them; a
//! thread that later resumes it would run from that stale SIPI vector.
//! [`DetachedKvmVcpu::reset`] drops them first.

use kvm_bindings::{KVM_MP_STATE_HALTED, KVM_MP_STATE_UNINITIALIZED, KVM_VCPUEVENT_VALID_SMM};
use std::os::fd::AsRawFd;

use super::{KvmVcpu, kick::WorkerSignal, vcpu::UnboundVcpu};
use crate::{Error, Result, VcpuResetError};

/// A KVM vCPU with no worker thread. It can move to the thread that resumes it.
#[derive(Debug)]
pub struct DetachedKvmVcpu {
    state: UnboundVcpu,
    signal: i32,
}

impl DetachedKvmVcpu {
    fn failure(&self, operation: &'static str) -> impl Fn(kvm_ioctls::Error) -> Error + '_ {
        move |source| Error::ConfigureVcpu {
            id: self.state.id,
            operation,
            source: source.into(),
        }
    }

    /// Whether the guest left the vCPU halted, as Linux leaves an offlined CPU.
    pub fn is_halted(&self) -> Result<bool> {
        let state = self
            .state
            .fd
            .get_mp_state()
            .map_err(self.failure("read MP state"))?;
        Ok(state.mp_state == KVM_MP_STATE_HALTED)
    }

    /// Clears a latched INIT, then returns the vCPU to waiting for INIT, which
    /// also drops a pending SIPI: KVM accepts a SIPI only after an INIT.
    pub fn reset(&mut self) -> std::result::Result<(), VcpuResetError> {
        let mut events = self.state.fd.get_vcpu_events().map_err(|source| {
            VcpuResetError::Unchanged(self.failure("read vCPU events")(source))
        })?;
        let mut state =
            self.state.fd.get_mp_state().map_err(|source| {
                VcpuResetError::Unchanged(self.failure("read MP state")(source))
            })?;
        // Only the SMM group carries the latched INIT; the rest stays as read.
        events.flags = KVM_VCPUEVENT_VALID_SMM;
        events.smi.latched_init = 0;
        state.mp_state = KVM_MP_STATE_UNINITIALIZED;

        self.state.fd.clear_tsc_save_anchor();
        self.state.fd.set_vcpu_events(&events).map_err(|source| {
            VcpuResetError::Unavailable(self.failure("clear latched INIT")(source))
        })?;
        self.state
            .fd
            .set_mp_state(state)
            .map_err(|source| VcpuResetError::Unavailable(self.failure("wait for INIT")(source)))
    }

    /// Reserves the kick signal on the calling thread and binds the vCPU to it.
    pub fn bind(self) -> Result<KvmVcpu> {
        let bind = || {
            let kick = WorkerSignal::reserve(self.state.id, self.signal)?;
            kick.configure(self.state.fd.as_raw_fd())?;
            Ok(kick)
        };
        let kick = bind().map_err(|source| Error::CreateVcpu {
            id: self.state.id,
            source,
        })?;
        Ok(KvmVcpu::bind(self.state, kick))
    }
}

impl KvmVcpu {
    /// Releases the worker's signal binding and retains the KVM vCPU.
    pub fn detach(self) -> std::result::Result<DetachedKvmVcpu, (Box<Self>, Error)> {
        let (state, signal) = self.unbind()?;
        Ok(DetachedKvmVcpu { state, signal })
    }
}

impl crate::X86DetachedVcpu for DetachedKvmVcpu {
    type Vcpu = KvmVcpu;

    fn is_halted(&self) -> Result<bool> {
        Self::is_halted(self)
    }

    fn reset(&mut self) -> std::result::Result<(), VcpuResetError> {
        Self::reset(self)
    }

    fn bind(self: Box<Self>) -> Result<KvmVcpu> {
        Self::bind(*self)
    }
}

// The suite lives under `tests/` so it stays out of the crate's counted source;
// it is still a unit-test module with access to crate-private items.
#[cfg(test)]
#[path = "../../tests/kvm_park/mod.rs"]
mod tests;
