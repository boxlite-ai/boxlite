// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::sync::{Mutex, MutexGuard, PoisonError};

#[cfg(target_arch = "x86_64")]
use crate::error::{Error, Result};
use crate::events::{Event, EventSender};

/// The execution state observed through [`VmControl`](crate::VmControl).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum VmStatus {
    /// The VM is ready to run.
    Created,
    /// The run has started.
    Running,
    /// Termination has been requested or the run is tearing down.
    Stopping,
    /// Execution has finished or the VM has been dropped.
    Exited,
}

#[derive(Debug)]
struct LifecycleState {
    status: VmStatus,
    #[cfg(any(test, target_arch = "x86_64"))]
    run_claimed: bool,
    sender: Option<EventSender>,
}

#[derive(Debug)]
pub(crate) struct Lifecycle {
    state: Mutex<LifecycleState>,
}

impl Lifecycle {
    pub(crate) fn new(sender: EventSender) -> Self {
        Self {
            state: Mutex::new(LifecycleState {
                status: VmStatus::Created,
                #[cfg(any(test, target_arch = "x86_64"))]
                run_claimed: false,
                sender: Some(sender),
            }),
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
        if !matches!(state.status, VmStatus::Created | VmStatus::Running) {
            return;
        }
        let Some(sender) = &state.sender else {
            return;
        };
        // Serialize setting the vCPU stop latch with admitting the first run.
        sender.send(Event::StopRequested);
        state.status = VmStatus::Stopping;
    }

    /// Claims the run and returns whether to start the vCPUs.
    #[cfg(target_arch = "x86_64")]
    pub(crate) fn begin_run(&self) -> Result<bool> {
        let mut state = self.state();
        if state.run_claimed || state.status == VmStatus::Exited {
            return Err(Error::AlreadyRan);
        }
        state.run_claimed = true;
        if state.status == VmStatus::Stopping {
            return Ok(false);
        }
        state.status = VmStatus::Running;
        Ok(true)
    }

    #[cfg(target_arch = "x86_64")]
    pub(crate) fn mark_stopping(&self) {
        self.state().status = VmStatus::Stopping;
    }

    pub(crate) fn mark_exited(&self) {
        let mut state = self.state();
        state.status = VmStatus::Exited;
        drop(state.sender.take());
    }
}

#[cfg(test)]
#[path = "../tests/lifecycle/mod.rs"]
mod tests;
