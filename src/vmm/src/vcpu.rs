// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! vCPU workers. Each runs on its own thread: it creates and configures its
//! vCPU, waits until every vCPU is configured, then runs the guest and
//! dispatches its exits until the VM ends. Every way a worker ends sends one
//! event, except a stop it observed, which some other sender already caused.

use std::{
    panic::{self, AssertUnwindSafe},
    sync::{Condvar, Mutex, PoisonError},
};

use boxlite_hypervisor::{Vcpu, VcpuExit, X86BootRegisters, X86Vcpu, X86Vm};

use crate::{
    chipset::Chipset,
    cpu_features::{BOOT_MSRS, vcpu_cpuid},
    error::{Error, Result},
    events::{Event, EventSender},
};

/// Holds the workers until every vCPU is configured, so no vCPU runs before
/// all exist. Unlike `std::sync::Barrier`, [`abort`](Self::abort) releases
/// them when a worker thread fails to start.
#[derive(Default)]
pub(crate) struct StartGate {
    /// Workers that arrived, and whether the gate was aborted.
    state: Mutex<(u8, bool)>,
    changed: Condvar,
}

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
pub(crate) struct Workers<'a, H: X86Vm> {
    pub(crate) host_vm: &'a H,
    pub(crate) vcpu_count: u8,
    pub(crate) boot_regs: &'a X86BootRegisters,
    pub(crate) chipset: &'a Chipset,
    pub(crate) sender: &'a EventSender,
    /// The kick handle of every configured vCPU, for the thread that stops them.
    pub(crate) kicks: &'a Mutex<Vec<<H::Vcpu as Vcpu>::Handle>>,
    pub(crate) gate: &'a StartGate,
}

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
    /// pending access.
    fn run_guest(&self, vcpu: &mut H::Vcpu, id: u8) -> Result<Option<Event>> {
        loop {
            // Checked before every entry: a stop that lands earlier still
            // returns from the next entry at once, since its kick is pending.
            if self.sender.is_stopping() {
                vcpu.complete_pending_io()?;
                return Ok(None);
            }
            match self.chipset.dispatch(vcpu.run()?) {
                None | Some(VcpuExit::Interrupted) => {}
                Some(VcpuExit::Shutdown) => return Ok(Some(Event::GuestShutdown)),
                Some(VcpuExit::Reset) => return Ok(Some(Event::GuestReset)),
                Some(exit) => {
                    return Err(Error::UnexpectedExit {
                        vcpu: id.into(),
                        exit: format!("{exit:?}"),
                    });
                }
            }
        }
    }
}

fn catch_panic<T>(id: u8, f: impl FnOnce() -> Result<T>) -> Result<T> {
    panic::catch_unwind(AssertUnwindSafe(f))
        .unwrap_or_else(|_| Err(Error::VcpuPanicked { vcpu: id.into() }))
}
