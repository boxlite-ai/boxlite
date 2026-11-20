// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::sync::Arc;

use crate::lifecycle::{Lifecycle, VmStatus};

/// Observes or stops a VM from another thread while its owner drives execution.
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
}
