// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! vCPU workers and their guest-entry checkpoints.

#[cfg(target_arch = "x86_64")]
use std::{
    panic::{self, AssertUnwindSafe},
    sync::{
        Condvar, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, SyncSender},
    },
};

use boxlite_hypervisor::{IoCompletion, Vcpu, VcpuExit};
#[cfg(target_arch = "x86_64")]
use boxlite_hypervisor::{VcpuResetError, X86BootRegisters, X86DetachedVcpu, X86Vcpu, X86Vm};

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

#[cfg(target_arch = "x86_64")]
mod driver;
#[cfg(target_arch = "x86_64")]
pub(crate) use driver::VcpuRun;

#[cfg(target_arch = "x86_64")]
type Detached<H> = Box<dyn X86DetachedVcpu<Vcpu = <H as boxlite_hypervisor::Vm>::Vcpu>>;
#[cfg(target_arch = "x86_64")]
type Kick<H> = <<H as boxlite_hypervisor::Vm>::Vcpu as Vcpu>::Handle;

#[cfg(target_arch = "x86_64")]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Startup {
    Configuring,
    Detaching,
    Checkpoint,
    Aborted,
}

/// The driver releases surplus workers to detach before permitting boot checkpoints.
#[cfg(target_arch = "x86_64")]
pub(crate) struct StartGate {
    phase: Mutex<Startup>,
    changed: Condvar,
}

#[cfg(target_arch = "x86_64")]
impl Default for StartGate {
    fn default() -> Self {
        Self {
            phase: Mutex::new(Startup::Configuring),
            changed: Condvar::new(),
        }
    }
}

#[cfg(target_arch = "x86_64")]
impl StartGate {
    fn phase(&self) -> Startup {
        *self.phase.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn release(&self, phase: Startup) {
        *self.phase.lock().unwrap_or_else(PoisonError::into_inner) = phase;
        self.changed.notify_all();
    }

    fn wait(&self, surplus: bool) -> bool {
        let phase = self.phase.lock().unwrap_or_else(PoisonError::into_inner);
        let phase = self
            .changed
            .wait_while(phase, |phase| match phase {
                Startup::Configuring => true,
                Startup::Detaching => !surplus,
                Startup::Checkpoint | Startup::Aborted => false,
            })
            .unwrap_or_else(PoisonError::into_inner);
        *phase != Startup::Aborted
    }
}

#[cfg(target_arch = "x86_64")]
enum WorkerOutput<H: X86Vm> {
    Stopped,
    Detached(Detached<H>, Result<()>),
    GrantFailed(Option<Detached<H>>, Error),
}

/// Resources borrowed by boot workers and later grants.
#[cfg(target_arch = "x86_64")]
pub(crate) struct Workers<'a, H: X86Vm> {
    pub(crate) host_vm: &'a H,
    pub(crate) boot_count: u8,
    pub(crate) max_vcpus: u8,
    pub(crate) boot_regs: &'a X86BootRegisters,
    pub(crate) chipset: &'a Chipset,
    pub(crate) sender: &'a EventSender,
    pub(crate) lifecycle: &'a Lifecycle,
    pub(crate) gate: &'a StartGate,
}

#[cfg(target_arch = "x86_64")]
impl<H: X86Vm> Workers<'_, H> {
    fn boot(&self, id: u8, ready: SyncSender<Kick<H>>, retire: &AtomicBool) -> WorkerOutput<H> {
        let vcpu = match catch_panic(id, || self.configure(id)) {
            Ok(vcpu) => vcpu,
            Err(error) => return self.terminal(Event::VcpuFailed(error)),
        };
        let surplus = id >= self.boot_count;
        let registered = match self.publish_ready(id, &vcpu, ready) {
            Ok(registered) => registered,
            Err(error) => return self.terminal(Event::VcpuFailed(error)),
        };
        if !registered || !self.gate.wait(surplus) || self.sender.is_stopping() {
            return WorkerOutput::Stopped;
        }
        if surplus {
            match catch_panic(id, || self.detach(vcpu, id, false)) {
                Ok(output) => output,
                Err(error) => self.terminal(Event::VcpuFailed(error)),
            }
        } else {
            self.execute(vcpu, id, retire)
        }
    }

    fn grant(
        &self,
        id: u8,
        handoff: Receiver<Detached<H>>,
        ready: SyncSender<Kick<H>>,
        authorize: Receiver<()>,
        retire: &AtomicBool,
    ) -> WorkerOutput<H> {
        let Ok(mut vcpu) = handoff.recv() else {
            return WorkerOutput::Stopped;
        };
        if self.sender.is_stopping() {
            return WorkerOutput::Detached(vcpu, Ok(()));
        }
        let prepared = catch_panic(id, || {
            Ok(match vcpu.reset() {
                Ok(()) => vcpu
                    .bind()
                    .map_err(|error| WorkerOutput::GrantFailed(None, error.into())),
                Err(VcpuResetError::Unchanged(error)) => {
                    Err(WorkerOutput::GrantFailed(Some(vcpu), error.into()))
                }
                Err(VcpuResetError::Unavailable(error)) => {
                    Err(WorkerOutput::GrantFailed(None, error.into()))
                }
            })
        });
        let vcpu = match prepared {
            Ok(Ok(vcpu)) => vcpu,
            Ok(Err(output)) => return output,
            Err(error) => return WorkerOutput::GrantFailed(None, error),
        };
        let registered = match self.publish_ready(id, &vcpu, ready) {
            Ok(registered) => registered,
            Err(error) => return WorkerOutput::GrantFailed(None, error),
        };
        if !registered || authorize.recv().is_err() || self.sender.is_stopping() {
            return match catch_panic(id, || self.detach(vcpu, id, false)) {
                Ok(output) => output,
                Err(error) => WorkerOutput::GrantFailed(None, error),
            };
        }
        self.execute(vcpu, id, retire)
    }

    fn publish_ready(&self, id: u8, vcpu: &H::Vcpu, ready: SyncSender<Kick<H>>) -> Result<bool> {
        catch_panic(id, || {
            let registered = ready.try_send(vcpu.handle()).is_ok();
            self.sender.wake();
            Ok(registered)
        })
    }

    fn configure(&self, id: u8) -> Result<H::Vcpu> {
        let mut vcpu = self.host_vm.create_vcpu(id.into())?;
        let cpuid = vcpu_cpuid(self.host_vm.supported_cpuid(), id, self.max_vcpus);
        vcpu.set_cpu_features(&cpuid, &BOOT_MSRS)?;
        if id == 0 {
            vcpu.set_boot_registers(self.boot_regs)?;
        }
        Ok(vcpu)
    }

    fn execute(&self, mut vcpu: H::Vcpu, id: u8, retire: &AtomicBool) -> WorkerOutput<H> {
        let outcome = catch_panic(id, || {
            loop {
                if let Some(event) = self
                    .lifecycle
                    .checkpoint(id, || pause_vcpu(self.chipset, &mut vcpu, id))?
                {
                    return Ok(self.terminal(event));
                }
                let stopping = self.sender.is_stopping();
                if stopping || retire.load(Ordering::SeqCst) {
                    let event = complete_pending_io(self.chipset, &mut vcpu, id)?;
                    if stopping || self.sender.is_stopping() {
                        return Ok(WorkerOutput::Stopped);
                    }
                    if let Some(event) = event {
                        return Ok(self.terminal(event));
                    }
                    return match self.detach(vcpu, id, true) {
                        Ok(output) => Ok(output),
                        Err(error) => Ok(WorkerOutput::GrantFailed(None, error)),
                    };
                }
                if let Some(event) = handle_exit(self.chipset, id, vcpu.run()?)? {
                    return Ok(self.terminal(event));
                }
            }
        });
        match outcome {
            Ok(output) => output,
            Err(error) => self.terminal(Event::VcpuFailed(error)),
        }
    }

    fn detach(&self, vcpu: H::Vcpu, id: u8, check_offline: bool) -> Result<WorkerOutput<H>> {
        let detached = vcpu.detach().map_err(|(_vcpu, error)| Error::from(error))?;
        let result = if check_offline {
            detached
                .is_halted()
                .map(|halted| {
                    if !halted {
                        tracing::warn!(vcpu = id, "retired a vCPU the guest had not offlined");
                    }
                })
                .map_err(Error::from)
        } else {
            Ok(())
        };
        Ok(WorkerOutput::Detached(detached, result))
    }

    fn terminal(&self, event: Event) -> WorkerOutput<H> {
        self.sender.send(event);
        WorkerOutput::Stopped
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

pub(crate) fn pause_vcpu(chipset: &Chipset, vcpu: &mut impl Vcpu, id: u8) -> Result<Option<Event>> {
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
