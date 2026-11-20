// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    sync::{Condvar, Mutex, MutexGuard, PoisonError},
    time::Duration,
};

use crate::{
    error::{ControlReason, Error, Result},
    events::{Event, EventSender},
};

/// The execution state observed through [`VmControl`](crate::VmControl).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum VmStatus {
    /// The VM is ready to run, possibly with an initial pause reserved.
    Created,
    /// The run has started and vCPUs may enter the guest.
    Running,
    /// Guest entry is closing while the driver collects vCPU acknowledgements.
    Pausing,
    /// Every vCPU is parked outside the guest.
    Paused,
    /// Termination has been requested or the run is tearing down.
    Stopping,
    /// Execution has finished or the VM has been dropped.
    Exited,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Command {
    Park(u64),
    Resume(u64),
}

#[derive(Debug)]
struct LifecycleState {
    status: VmStatus,
    #[cfg(any(test, target_arch = "x86_64"))]
    run_claimed: bool,
    sender: Option<EventSender>,
    /// Exclusive slot for a control operation awaiting the driver.
    command: Option<Command>,
    epoch: u64,
    completed_epoch: u64,
    #[cfg(any(test, target_arch = "x86_64"))]
    acknowledgements: u64,
}

impl LifecycleState {
    fn is_terminal(&self) -> bool {
        matches!(self.status, VmStatus::Stopping | VmStatus::Exited)
            || self.sender.as_ref().is_some_and(EventSender::is_stopping)
    }

    fn sender(&self) -> &EventSender {
        self.sender.as_ref().expect("live lifecycle has a sender")
    }

    #[cfg(any(test, target_arch = "x86_64"))]
    fn start_pause(&mut self, epoch: u64) {
        self.epoch = epoch;
        self.status = VmStatus::Pausing;
        self.acknowledgements = 0;
    }

    #[cfg(any(test, target_arch = "x86_64"))]
    fn acknowledge(&mut self, epoch: u64, id: u8) {
        if self.status == VmStatus::Pausing && self.epoch == epoch && id < 64 {
            self.acknowledgements |= 1u64 << id;
        }
    }
}

#[derive(Debug)]
pub(crate) struct Lifecycle {
    device_less: bool,
    state: Mutex<LifecycleState>,
    changed: Condvar,
}

impl Lifecycle {
    pub(crate) fn new(sender: EventSender, device_less: bool) -> Self {
        Self {
            device_less,
            state: Mutex::new(LifecycleState {
                status: VmStatus::Created,
                #[cfg(any(test, target_arch = "x86_64"))]
                run_claimed: false,
                sender: Some(sender),
                command: None,
                epoch: 0,
                completed_epoch: 0,
                #[cfg(any(test, target_arch = "x86_64"))]
                acknowledgements: 0,
            }),
            changed: Condvar::new(),
        }
    }

    fn state(&self) -> MutexGuard<'_, LifecycleState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn status(&self) -> VmStatus {
        self.state().status
    }

    pub(crate) fn stop(&self) {
        let mut state = self.state();
        if matches!(state.status, VmStatus::Stopping | VmStatus::Exited) {
            return;
        }
        // Serialize setting the vCPU stop latch with admitting the first run.
        state.sender().send(Event::StopRequested);
        state.status = VmStatus::Stopping;
        state.command = None;
        self.changed.notify_all();
    }

    pub(crate) fn pause(&self, timeout: Duration) -> Result<()> {
        let mut state = self.state();
        let invalid = || control_error("pause", ControlReason::InvalidState);
        if state.is_terminal() {
            return Err(invalid());
        }
        if !self.device_less {
            return Err(control_error("pause", ControlReason::UnsupportedDevice));
        }
        if state.command.is_some() || !matches!(state.status, VmStatus::Created | VmStatus::Running)
        {
            return Err(invalid());
        }
        let epoch = state.epoch.checked_add(1).ok_or_else(invalid)?;
        let command = Command::Park(epoch);
        state.command = Some(command);
        if state.status == VmStatus::Created {
            return Ok(());
        }

        state.sender().wake();
        let (mut state, result) = self.await_pause(state, epoch, timeout);
        // The driver takes the command under this same lock. Once it does,
        // the vCPUs keep parking even if this caller times out.
        if state.command == Some(command) {
            state.command = None;
        }
        result.map_err(|reason| control_error("pause", reason))
    }

    pub(crate) fn resume(&self) -> Result<()> {
        let mut state = self.state();
        if state.is_terminal() || state.status != VmStatus::Paused || state.command.is_some() {
            return Err(control_error("resume", ControlReason::InvalidState));
        }
        let epoch = state.epoch;
        state.command = Some(Command::Resume(epoch));
        state.sender().wake();
        let state = self
            .changed
            .wait_while(state, |state| {
                !state.is_terminal() && state.status == VmStatus::Paused && state.epoch == epoch
            })
            .unwrap_or_else(PoisonError::into_inner);
        if state.is_terminal() {
            return Err(control_error("resume", ControlReason::TerminalOutcome));
        }
        Ok(())
    }

    pub(crate) fn wait_paused(&self, timeout: Duration) -> Result<()> {
        let state = self.state();
        if state.is_terminal() {
            return Err(control_error("wait_paused", ControlReason::TerminalOutcome));
        }
        let epoch = match (state.status, state.command) {
            (VmStatus::Created, Some(Command::Park(epoch))) => epoch,
            (VmStatus::Pausing | VmStatus::Paused, _) => state.epoch,
            _ => return Err(control_error("wait_paused", ControlReason::InvalidState)),
        };
        self.await_pause(state, epoch, timeout)
            .1
            .map_err(|reason| control_error("wait_paused", reason))
    }

    fn await_pause<'a>(
        &self,
        mut state: MutexGuard<'a, LifecycleState>,
        epoch: u64,
        timeout: Duration,
    ) -> (
        MutexGuard<'a, LifecycleState>,
        std::result::Result<(), ControlReason>,
    ) {
        if !timeout.is_zero() {
            state = self
                .changed
                .wait_timeout_while(state, timeout, |state| {
                    !state.is_terminal() && state.completed_epoch < epoch
                })
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        let result = if state.is_terminal() {
            Err(ControlReason::TerminalOutcome)
        } else if state.completed_epoch >= epoch {
            Ok(())
        } else {
            Err(ControlReason::DeadlineTimeout)
        };
        (state, result)
    }

    /// Claims the run and closes guest entry if the first pause was reserved.
    #[cfg(any(test, target_arch = "x86_64"))]
    pub(crate) fn begin_run(&self) -> Result<bool> {
        let mut state = self.state();
        if state.run_claimed || state.status == VmStatus::Exited {
            return Err(Error::AlreadyRan);
        }
        state.run_claimed = true;
        if state.status == VmStatus::Stopping {
            return Ok(false);
        }
        if let Some(Command::Park(epoch)) = state.command.take() {
            state.start_pause(epoch);
        } else {
            state.status = VmStatus::Running;
        }
        Ok(true)
    }

    /// Handles commands and acknowledgements on the run thread. Returns
    /// whether to kick workers that may still be inside the guest.
    #[cfg(any(test, target_arch = "x86_64"))]
    pub(crate) fn drive(&self, count: u8) -> bool {
        let mut state = self.state();
        if state.is_terminal() {
            return false;
        }
        match state.command.take() {
            Some(Command::Park(epoch)) => {
                state.start_pause(epoch);
                return true;
            }
            Some(Command::Resume(epoch)) if state.epoch == epoch => {
                state.status = VmStatus::Running;
                self.changed.notify_all();
            }
            _ => {}
        }
        let all = u64::MAX >> (64 - count);
        if state.status == VmStatus::Pausing && state.acknowledgements & all == all {
            state.completed_epoch = state.epoch;
            state.status = VmStatus::Paused;
            self.changed.notify_all();
        }
        false
    }

    #[cfg(target_arch = "x86_64")]
    pub(crate) fn checkpoint(
        &self,
        id: u8,
        vcpu: &mut impl boxlite_hypervisor::Vcpu,
    ) -> Result<()> {
        if !self.device_less {
            return Ok(());
        }
        let mut state = self.state();
        while matches!(state.status, VmStatus::Pausing | VmStatus::Paused) && !state.is_terminal() {
            let epoch = state.epoch;
            drop(state);
            vcpu.complete_pending_io()?;
            match vcpu.notify_guest_stopped() {
                Err(boxlite_hypervisor::Error::ConfigureVcpu { source, .. })
                    if source.kind() == std::io::ErrorKind::Unsupported => {}
                result => result?,
            }
            state = self.state();
            if !state.is_terminal() {
                state.acknowledge(epoch, id);
                state.sender().wake();
            }
            state = self
                .changed
                .wait_while(state, |state| {
                    state.epoch == epoch
                        && matches!(state.status, VmStatus::Pausing | VmStatus::Paused)
                        && !state.is_terminal()
                })
                .unwrap_or_else(PoisonError::into_inner);
        }
        Ok(())
    }

    #[cfg(any(test, target_arch = "x86_64"))]
    pub(crate) fn mark_stopping(&self) {
        let mut state = self.state();
        if !state.is_terminal() {
            state.sender().send(Event::StopRequested);
        }
        state.status = VmStatus::Stopping;
        state.command = None;
        self.changed.notify_all();
    }

    pub(crate) fn mark_exited(&self) {
        let mut state = self.state();
        state.status = VmStatus::Exited;
        state.command = None;
        drop(state.sender.take());
        self.changed.notify_all();
    }
}

fn control_error(operation: &'static str, reason: ControlReason) -> Error {
    Error::Control { operation, reason }
}

#[cfg(test)]
#[path = "../tests/lifecycle/mod.rs"]
mod tests;
