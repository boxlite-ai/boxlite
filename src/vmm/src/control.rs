// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{sync::Arc, time::Duration};

use crate::{
    error::Result,
    lifecycle::{Lifecycle, VmStatus},
};

/// Observes or controls a VM from another thread while its owner drives execution.
/// Dropping a control handle has no effect on execution.
#[derive(Clone, Debug)]
pub struct VmControl {
    lifecycle: Arc<Lifecycle>,
}

impl VmControl {
    pub(crate) fn new(lifecycle: Arc<Lifecycle>) -> Self {
        Self { lifecycle }
    }

    /// Returns the current lifecycle state.
    pub fn status(&self) -> VmStatus {
        self.lifecycle.status()
    }

    /// Requests a stop, including before execution starts, without waiting for exit.
    pub fn stop(&self) {
        self.lifecycle.stop();
    }

    /// Reserves an initial pause in `Created`, or waits up to five seconds
    /// for a running device-less VM to park all vCPUs. An accepted pause
    /// continues after a timeout and can be observed with [`Self::wait_paused`].
    pub fn pause(&self) -> Result<()> {
        self.lifecycle.pause(Duration::from_secs(5))
    }

    /// Reopens guest entry for a paused VM after the run driver accepts it.
    pub fn resume(&self) -> Result<()> {
        self.lifecycle.resume()
    }

    /// Waits for the current pause epoch, including a reserved initial pause.
    /// A zero timeout checks the current condition while holding the lock.
    pub fn wait_paused(&self, timeout: Duration) -> Result<()> {
        self.lifecycle.wait_paused(timeout)
    }
}
