// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Device interrupt assignment and line routing.
//!
//! Provides [`IrqChip`], an object-safe trait over hypervisor interrupt delivery,
//! and [`IrqLine`], a single-owner interrupt line that deasserts on drop.

use std::sync::Arc;

use boxlite_hypervisor::Vm;

use crate::error::{Error, Result};

/// An object-safe interface for delivering device interrupts.
///
/// Implemented for any hypervisor [`Vm`] backend to deliver line interrupts
/// to the in-kernel interrupt controller.
pub(crate) trait IrqChip: Send + Sync {
    /// Sets the level of an interrupt line.
    fn set_irq_line(&self, line: u32, level: bool) -> Result<()>;
}

impl<V: Vm + Sync> IrqChip for V {
    fn set_irq_line(&self, line: u32, level: bool) -> Result<()> {
        Vm::set_irq_line(self, line, level).map_err(Error::from)
    }
}

/// A dedicated interrupt line owned by a single device.
///
/// An edge-triggered interrupt is delivered via [`IrqLine::pulse`], which sets
/// the line active and immediately clears it. The line deasserts automatically
/// on [`Drop`] if left asserted.
pub(crate) struct IrqLine {
    chip: Arc<dyn IrqChip>,
    line: u32,
    level: bool,
}

impl std::fmt::Debug for IrqLine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IrqLine")
            .field("line", &self.line)
            .field("level", &self.level)
            .finish()
    }
}

impl IrqLine {
    /// Creates a new interrupt line tied to the specified line number.
    pub(crate) fn new(chip: Arc<dyn IrqChip>, line: u32) -> Self {
        Self {
            chip,
            line,
            level: false,
        }
    }

    /// The line number (e.g. GSI) assigned to this line.
    pub(crate) fn line(&self) -> u32 {
        self.line
    }

    /// Returns the current asserted state of the line.
    pub(crate) fn level(&self) -> bool {
        self.level
    }

    /// Sets the line to the given level.
    pub(crate) fn set_level(&mut self, level: bool) -> Result<()> {
        self.chip.set_irq_line(self.line, level)?;
        self.level = level;
        Ok(())
    }

    /// Pulses an edge-triggered interrupt (asserts then deasserts).
    pub(crate) fn pulse(&mut self) -> Result<()> {
        self.set_level(true)?;
        self.set_level(false)
    }
}

impl Drop for IrqLine {
    fn drop(&mut self) {
        if self.level {
            let _ = self.chip.set_irq_line(self.line, false);
        }
    }
}

#[cfg(test)]
#[path = "../tests/irq/mod.rs"]
mod tests;
