// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Device interrupt lines. HVF and KVM provide an in-kernel interrupt
//! controller, so raising a line is one host call; WHP (M10) provides only
//! local APICs.

use std::sync::Arc;

use crate::error::Result;

/// The host interrupt controller as devices see it. Every host VM is one; a
/// wrapper can add behaviour, such as counting or waking parked vCPUs.
pub(crate) trait IrqChip: Send + Sync {
    /// Sets interrupt `line`, a GSI on x86_64 or an SPI on arm64, to `level`.
    fn set_irq_line(&self, line: u32, level: bool) -> boxlite_hypervisor::Result<()>;
}

impl<V: boxlite_hypervisor::Vm> IrqChip for V {
    fn set_irq_line(&self, line: u32, level: bool) -> boxlite_hypervisor::Result<()> {
        boxlite_hypervisor::Vm::set_irq_line(self, line, level)
    }
}

/// One device interrupt line. It is not `Clone`, so a device cannot share its
/// line; the device manager creates one per line.
pub(crate) struct IrqLine {
    chip: Arc<dyn IrqChip>,
    line: u32,
}

impl IrqLine {
    pub(crate) fn new(chip: Arc<dyn IrqChip>, line: u32) -> Self {
        Self { chip, line }
    }

    /// Raises an edge: sets the line, then clears it. A failed set skips the
    /// clear; a failed clear leaves the line set.
    pub(crate) fn pulse(&self) -> Result<()> {
        self.chip.set_irq_line(self.line, true)?;
        self.chip.set_irq_line(self.line, false)?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "../tests/irq/mod.rs"]
mod tests;
