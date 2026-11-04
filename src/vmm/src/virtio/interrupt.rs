// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio-mmio interrupt handle.
//!
//! The transport owns one [`MmioInterrupt`] and gives the device an
//! `Arc<dyn VirtioInterrupt>` through [`ActivationContext`]. The handle keeps
//! the interrupt status bits, the device status register and the configuration
//! generation, and raises the device's edge interrupt line.
//!
//! Linux reads InterruptStatus, acknowledges the bits it read, and then handles
//! them. On an edge line, a bit that arrives between the read and the
//! acknowledgement would otherwise have no future edge, so [`ack_interrupt`]
//! pulses again while any status remains set.
//!
//! [`ActivationContext`]: super::ActivationContext

use std::sync::atomic::{AtomicU8, Ordering};

use super::{NEEDS_RESET, VirtioInterrupt};
use crate::irq::IrqLine;

/// The device used a buffer.
const USED: u8 = 0x1;
/// The device configuration changed.
const CONFIG: u8 = 0x2;

/// The virtio-mmio interrupt and status handle.
pub(crate) struct MmioInterrupt {
    line: IrqLine,
    status: AtomicU8,
    device_status: AtomicU8,
    config_generation: AtomicU8,
}

impl MmioInterrupt {
    /// Wraps the device's interrupt line.
    pub(crate) fn new(line: IrqLine) -> Self {
        Self {
            line,
            status: AtomicU8::new(0),
            device_status: AtomicU8::new(0),
            config_generation: AtomicU8::new(0),
        }
    }

    /// Clears the interrupt and device status for a driver reset. The
    /// configuration generation stays monotonic across resets.
    pub(crate) fn reset(&self) {
        self.status.store(0, Ordering::SeqCst);
        self.device_status.store(0, Ordering::SeqCst);
    }

    /// Adds `bits` to the device status unless a bit in `blocked` is set.
    ///
    /// A driver status write uses this so it cannot replace the register with
    /// a snapshot taken before a worker set [`NEEDS_RESET`] or `FAILED`.
    pub(crate) fn update_device_status(&self, bits: u8, blocked: u8) {
        let mut current = self.device_status.load(Ordering::SeqCst);
        loop {
            if current & blocked != 0 {
                return;
            }
            match self.device_status.compare_exchange_weak(
                current,
                current | bits,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => return,
                Err(actual) => current = actual,
            }
        }
    }

    /// Pulses the line. A failed pulse leaves the status bit set so a later
    /// raise or acknowledgement can try again.
    fn pulse(&self) {
        if let Err(error) = self.line.pulse() {
            tracing::warn!(%error, "raising a virtio interrupt failed");
        }
    }
}

impl VirtioInterrupt for MmioInterrupt {
    fn raise(&self) {
        self.status.fetch_or(USED, Ordering::SeqCst);
        self.pulse();
    }

    fn interrupt_status(&self) -> u8 {
        self.status.load(Ordering::SeqCst)
    }

    fn ack_interrupt(&self, bits: u8) {
        let previous = self.status.fetch_and(!bits, Ordering::SeqCst);
        if previous & !bits != 0 {
            self.pulse();
        }
    }

    fn config_generation(&self) -> u8 {
        self.config_generation.load(Ordering::SeqCst)
    }

    fn raise_config(&self) {
        self.config_generation.fetch_add(1, Ordering::SeqCst);
        self.status.fetch_or(CONFIG, Ordering::SeqCst);
        self.pulse();
    }

    fn device_status(&self) -> u8 {
        self.device_status.load(Ordering::SeqCst)
    }

    fn set_device_status(&self, status: u8) {
        self.device_status.store(status, Ordering::SeqCst);
    }

    fn set_needs_reset(&self) {
        self.device_status.fetch_or(NEEDS_RESET, Ordering::SeqCst);
    }
}

#[cfg(test)]
#[path = "../../tests/virtio/interrupt.rs"]
mod tests;
