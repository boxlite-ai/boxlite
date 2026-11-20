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

#[derive(Clone, Copy, Debug)]
enum State {
    Created,
    // A pre-start stop still allows the first run to perform cleanup.
    StoppedBeforeRun,
    #[cfg(target_arch = "x86_64")]
    Running,
    #[cfg(target_arch = "x86_64")]
    Stopping,
    Exited,
}

#[derive(Debug)]
struct LifecycleState {
    phase: State,
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
                phase: State::Created,
                sender: Some(sender),
            }),
        }
    }

    fn state(&self) -> MutexGuard<'_, LifecycleState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn status(&self) -> VmStatus {
        match self.state().phase {
            State::Created => VmStatus::Created,
            #[cfg(target_arch = "x86_64")]
            State::Running => VmStatus::Running,
            State::StoppedBeforeRun => VmStatus::Stopping,
            #[cfg(target_arch = "x86_64")]
            State::Stopping => VmStatus::Stopping,
            State::Exited => VmStatus::Exited,
        }
    }

    pub(crate) fn stop(&self) {
        let mut state = self.state();
        let stopping = match state.phase {
            State::Created => State::StoppedBeforeRun,
            #[cfg(target_arch = "x86_64")]
            State::Running => State::Stopping,
            _ => return,
        };
        let Some(sender) = &state.sender else {
            return;
        };
        // Serialize setting the vCPU stop latch with admitting the first run.
        sender.send(Event::StopRequested);
        state.phase = stopping;
    }

    /// Claims the run and returns whether to start the vCPUs.
    #[cfg(target_arch = "x86_64")]
    pub(crate) fn begin_run(&self) -> Result<bool> {
        let mut state = self.state();
        match state.phase {
            State::Created => {
                state.phase = State::Running;
                Ok(true)
            }
            State::StoppedBeforeRun => {
                state.phase = State::Stopping;
                Ok(false)
            }
            _ => Err(Error::AlreadyRan),
        }
    }

    #[cfg(target_arch = "x86_64")]
    pub(crate) fn mark_stopping(&self) {
        self.state().phase = State::Stopping;
    }

    pub(crate) fn mark_exited(&self) {
        let mut state = self.state();
        state.phase = State::Exited;
        drop(state.sender.take());
    }
}

#[cfg(test)]
#[path = "../tests/lifecycle/mod.rs"]
mod tests;
