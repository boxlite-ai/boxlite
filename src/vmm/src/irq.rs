// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Device interrupt lines. HVF and KVM provide an in-kernel interrupt
//! controller, so raising a line is one host call; WHP (M10) provides only
//! local APICs.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use crate::error::Result;

/// The host interrupt controller as devices see it. Every host VM is one; a
/// wrapper can add behaviour, such as counting.
pub(crate) trait IrqChip: Send + Sync {
    /// Sets interrupt `line`, a GSI on x86_64 or an SPI on arm64, to `level`.
    fn set_line(&self, line: u32, level: bool) -> Result<()>;
}

impl<V: boxlite_hypervisor::Vm> IrqChip for V {
    fn set_line(&self, line: u32, level: bool) -> Result<()> {
        Ok(self.set_irq_line(line, level)?)
    }
}

/// One device interrupt line. It is not `Clone`, so a device cannot share its
/// line. A line held high is lowered when its owner drops it, as OpenVMM's
/// does.
pub(crate) struct IrqLine {
    chip: Arc<dyn IrqChip>,
    line: u32,
    high: AtomicBool,
}

impl IrqLine {
    pub(crate) fn new(chip: Arc<dyn IrqChip>, line: u32) -> Self {
        Self {
            chip,
            line,
            high: AtomicBool::new(false),
        }
    }

    /// Holds the line at `level`, for a level-triggered device such as the
    /// PL011. Setting the level the line already has makes no host call. The
    /// owning device calls it under its own lock, which keeps the recorded
    /// level and the host line in step.
    pub(crate) fn set_level(&self, level: bool) -> Result<()> {
        let before = self.high.swap(level, Ordering::SeqCst);
        if before == level {
            return Ok(());
        }
        if let Err(error) = self.chip.set_line(self.line, level) {
            self.high.store(before, Ordering::SeqCst);
            return Err(error);
        }
        Ok(())
    }

    /// Raises an edge: sets the line, then clears it. A failed set skips the
    /// clear; a failed clear leaves the line set, which drop then lowers.
    pub(crate) fn pulse(&self) -> Result<()> {
        self.chip.set_line(self.line, true)?;
        self.high.store(true, Ordering::SeqCst);
        self.chip.set_line(self.line, false)?;
        self.high.store(false, Ordering::SeqCst);
        Ok(())
    }
}

impl Drop for IrqLine {
    fn drop(&mut self) {
        if *self.high.get_mut() {
            // The device is gone, so nothing will clear the line; the VM is
            // ending as well, so a failure can only be logged.
            if let Err(error) = self.chip.set_line(self.line, false) {
                tracing::warn!(line = self.line, %error, "lowering a dropped interrupt line failed");
            }
        }
    }
}

#[cfg(test)]
#[path = "../tests/irq/mod.rs"]
mod tests;
