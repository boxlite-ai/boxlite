// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! vCPU workers. Each runs on its own thread: it creates and configures its
//! vCPU, waits until every vCPU is configured, then runs the guest and
//! dispatches its exits until the VM ends. Every way a worker ends sends one
//! event, except a stop it observed, which some other sender already caused.

#[cfg(target_arch = "x86_64")]
use std::{
    panic::{self, AssertUnwindSafe},
    sync::{Condvar, Mutex, PoisonError},
};

use boxlite_hypervisor::{IoCompletion, Vcpu, VcpuExit};
#[cfg(target_arch = "x86_64")]
use boxlite_hypervisor::{X86BootRegisters, X86Vcpu, X86Vm};

use crate::{
    chipset::Chipset,
    error::{Error, Result},
    events::Event,
};
#[cfg(target_arch = "x86_64")]
use crate::{
    cpu_features::{BOOT_MSRS, vcpu_cpuid},
    events::EventSender,
    lifecycle::Lifecycle,
};

/// Holds the workers until every vCPU is configured, so no vCPU runs before
/// all exist. Unlike `std::sync::Barrier`, [`abort`](Self::abort) releases
/// them when a worker thread fails to start.
#[derive(Default)]
#[cfg(target_arch = "x86_64")]
pub(crate) struct StartGate {
    /// Workers that arrived, and whether the gate was aborted.
    state: Mutex<(u8, bool)>,
    changed: Condvar,
}

#[cfg(target_arch = "x86_64")]
impl StartGate {
    fn arrive_and_wait(&self, count: u8) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.0 += 1;
        self.changed.notify_all();
        drop(
            self.changed
                .wait_while(state, |(arrived, aborted)| *arrived < count && !*aborted)
                .unwrap_or_else(PoisonError::into_inner),
        );
    }

    pub(crate) fn abort(&self) {
        self.state.lock().unwrap_or_else(PoisonError::into_inner).1 = true;
        self.changed.notify_all();
    }
}

/// What every worker of one VM shares.
#[cfg(target_arch = "x86_64")]
pub(crate) struct Workers<'a, H: X86Vm> {
    pub(crate) host_vm: &'a H,
    pub(crate) vcpu_count: u8,
    pub(crate) boot_regs: &'a X86BootRegisters,
    pub(crate) chipset: &'a Chipset,
    pub(crate) sender: &'a EventSender,
    pub(crate) lifecycle: &'a Lifecycle,
    /// The configured vCPUs' kick handles, used for pause and stop.
    pub(crate) kicks: &'a Mutex<Vec<<H::Vcpu as Vcpu>::Handle>>,
    pub(crate) gate: &'a StartGate,
}

#[cfg(target_arch = "x86_64")]
impl<H: X86Vm> Workers<'_, H> {
    /// The body of the thread of vCPU `id`. A panic in it, such as a device
    /// whose lock an earlier panic poisoned, ends the VM with
    /// [`Error::VcpuPanicked`] instead of leaving the thread.
    pub(crate) fn run(&self, id: u8) {
        let vcpu = match catch_panic(id, || self.configure(id)) {
            Ok(vcpu) => Some(vcpu),
            Err(error) => {
                // Sent before arriving, so the latch is set before any vCPU
                // leaves the gate and none enters the guest.
                self.sender.send(Event::VcpuFailed(error));
                None
            }
        };
        // A failed vCPU still arrives, so the others are never left waiting.
        self.gate.arrive_and_wait(self.vcpu_count);
        let Some(mut vcpu) = vcpu else {
            return;
        };
        match catch_panic(id, || self.run_guest(&mut vcpu, id)) {
            Ok(Some(event)) => self.sender.send(event),
            Ok(None) => {}
            Err(error) => self.sender.send(Event::VcpuFailed(error)),
        }
    }

    fn configure(&self, id: u8) -> Result<H::Vcpu> {
        let mut vcpu = self.host_vm.create_vcpu(id.into())?;
        let cpuid = vcpu_cpuid(self.host_vm.supported_cpuid(), id, self.vcpu_count);
        vcpu.set_cpu_features(&cpuid, &BOOT_MSRS)?;
        // The other vCPUs wait in their reset state for INIT and SIPI.
        if id == 0 {
            vcpu.set_boot_registers(self.boot_regs)?;
        }
        self.kicks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(vcpu.handle());
        Ok(vcpu)
    }

    /// Runs the guest until it asks to end, which returns the event, or until
    /// another sender ends the VM, which returns `None` after completing the
    /// pending I/O.
    fn run_guest(&self, vcpu: &mut H::Vcpu, id: u8) -> Result<Option<Event>> {
        loop {
            if let Some(event) = self
                .lifecycle
                .checkpoint(id, || park_vcpu(self.chipset, vcpu, id))?
            {
                return Ok(Some(event));
            }
            // A stop may have released this worker from its checkpoint.
            if self.sender.is_stopping() {
                let _ = complete_pending_io(self.chipset, vcpu, id)?;
                return Ok(None);
            }
            let exit = vcpu.run()?;
            if let Some(event) = handle_exit(self.chipset, id, exit)? {
                return Ok(Some(event));
            }
        }
    }
}

#[cfg(target_arch = "x86_64")]
fn catch_panic<T>(id: u8, f: impl FnOnce() -> Result<T>) -> Result<T> {
    panic::catch_unwind(AssertUnwindSafe(f))
        .unwrap_or_else(|_| Err(Error::VcpuPanicked { vcpu: id.into() }))
}

pub(crate) fn handle_exit(chipset: &Chipset, id: u8, exit: VcpuExit<'_>) -> Result<Option<Event>> {
    match chipset.dispatch(exit) {
        None | Some(VcpuExit::Interrupted) => Ok(None),
        Some(VcpuExit::Shutdown) => Ok(Some(Event::GuestShutdown)),
        Some(VcpuExit::Reset) => Ok(Some(Event::GuestReset)),
        Some(exit) => Err(Error::UnexpectedExit {
            vcpu: id.into(),
            exit: format!("{exit:?}"),
        }),
    }
}

pub(crate) fn complete_pending_io(
    chipset: &Chipset,
    vcpu: &mut impl Vcpu,
    id: u8,
) -> Result<Option<Event>> {
    while let IoCompletion::Exit(exit) = vcpu.complete_pending_io()? {
        if let Some(event) = handle_exit(chipset, id, exit)? {
            return Ok(Some(event));
        }
    }
    Ok(None)
}

pub(crate) fn park_vcpu(chipset: &Chipset, vcpu: &mut impl Vcpu, id: u8) -> Result<Option<Event>> {
    if let Some(event) = complete_pending_io(chipset, vcpu, id)? {
        return Ok(Some(event));
    }
    match vcpu.notify_guest_stopped() {
        Err(boxlite_hypervisor::Error::ConfigureVcpu { source, .. })
            if source.kind() == std::io::ErrorKind::Unsupported => {}
        result => result?,
    }
    Ok(None)
}
