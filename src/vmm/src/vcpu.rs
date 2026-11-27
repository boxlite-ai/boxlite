// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! vCPU workers. Each runs on its own thread: it creates and configures its
//! vCPU, waits for the VM driver to open the start gate, then runs the guest and
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

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use crate::snapshot::state::{MachineState, VcpuRecord};
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

/// Holds configured vCPUs until the driver allows guest entry.
#[derive(Default)]
#[cfg(target_arch = "x86_64")]
pub(crate) struct StartGate {
    state: Mutex<StartState>,
    changed: Condvar,
}

#[derive(Default)]
#[cfg(target_arch = "x86_64")]
struct StartState {
    ready: u8,
    go: bool,
    aborted: bool,
}

#[cfg(target_arch = "x86_64")]
impl StartGate {
    fn arrive_and_wait(&self, count: u8, sender: &EventSender) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.ready += 1;
        if state.ready >= count && !state.aborted {
            sender.wake();
        }
        let state = self
            .changed
            .wait_while(state, |state| !state.go && !state.aborted)
            .unwrap_or_else(PoisonError::into_inner);
        !state.aborted
    }

    pub(crate) fn is_ready(&self, count: u8) -> bool {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.ready >= count && !state.aborted
    }

    pub(crate) fn release(&self) {
        self.state.lock().unwrap_or_else(PoisonError::into_inner).go = true;
        self.changed.notify_all();
    }

    pub(crate) fn abort(&self) {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .aborted = true;
        self.changed.notify_all();
    }
}

#[cfg(target_arch = "x86_64")]
pub(crate) enum Startup<'a> {
    Boot(&'a X86BootRegisters),
    #[cfg(target_os = "linux")]
    Restore(&'a MachineState),
}

/// What every worker of one VM shares.
#[cfg(target_arch = "x86_64")]
pub(crate) struct Workers<'a, H: X86Vm> {
    pub(crate) host_vm: &'a H,
    pub(crate) vcpu_count: u8,
    pub(crate) startup: Startup<'a>,
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
        match catch_panic(id, || {
            let mut vcpu = self.configure(id)?;
            if !self.gate.arrive_and_wait(self.vcpu_count, self.sender) {
                return Ok(None);
            }
            self.run_guest(&mut vcpu, id)
        }) {
            Ok(Some(event)) => self.sender.send(event),
            Ok(None) => {}
            Err(error) => {
                self.sender.send(Event::VcpuFailed(error));
                self.gate.abort();
            }
        }
    }

    fn configure(&self, id: u8) -> Result<H::Vcpu> {
        let mut vcpu = self.host_vm.create_vcpu(id.into())?;
        match self.startup {
            Startup::Boot(regs) => {
                let cpuid = vcpu_cpuid(self.host_vm.supported_cpuid(), id, self.vcpu_count);
                vcpu.set_cpu_features(&cpuid, &BOOT_MSRS)?;
                // The other vCPUs wait in their reset state for INIT and SIPI.
                if id == 0 {
                    vcpu.set_boot_registers(regs)?;
                }
            }
            #[cfg(target_os = "linux")]
            Startup::Restore(machine) => {
                let record = &machine.vcpus[usize::from(id)];
                vcpu.restore_state(&record.state)?;
                match vcpu.notify_guest_stopped() {
                    Err(boxlite_hypervisor::Error::ConfigureVcpu { source, .. })
                        if source.kind() == std::io::ErrorKind::Unsupported => {}
                    result => result?,
                }
            }
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
            #[cfg(target_os = "linux")]
            let checkpoint = self
                .lifecycle
                .checkpoint_with_capture(id, vcpu, |vcpu| park_vcpu(self.chipset, vcpu, id));
            #[cfg(not(target_os = "linux"))]
            let checkpoint = self
                .lifecycle
                .checkpoint(id, || park_vcpu(self.chipset, vcpu, id));
            if let Some(event) = checkpoint? {
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

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub(crate) fn capture(vcpu: &mut impl X86Vcpu, id: u8) -> Result<VcpuRecord> {
    let state = vcpu.save_state()?;
    Ok(VcpuRecord { id, state })
}
