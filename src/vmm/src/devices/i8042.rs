// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The i8042 keyboard controller, kept for the CPU reset Linux sends through
//! it (`reboot=k`); the guest kernel has no keyboard driver.

use std::{cell::Cell, convert::Infallible};

use vm_superio::{I8042Device, Trigger};

use crate::{
    bus::BusDevice,
    events::{Event, EventSender},
};

/// Turns the controller's CPU reset into [`Event::GuestReset`], once: the
/// first reset ends the VM, and Linux writes up to ten.
struct ResetTrigger {
    event_sender: EventSender,
    reset_sent: Cell<bool>,
}

impl Trigger for ResetTrigger {
    type E = Infallible;

    fn trigger(&self) -> Result<(), Infallible> {
        if !self.reset_sent.replace(true) {
            self.event_sender.send(Event::GuestReset);
        }
        Ok(())
    }
}

/// The controller behind port 0x60, vm-superio's register 0, and port 0x64,
/// its register 4; KVM serves 0x61, between them, for the PIT.
pub(crate) struct I8042 {
    controller: I8042Device<ResetTrigger>,
}

impl I8042 {
    pub(crate) fn new(event_sender: EventSender) -> Self {
        Self {
            controller: I8042Device::new(ResetTrigger {
                event_sender,
                reset_sent: Cell::new(false),
            }),
        }
    }
}

// Each port is one byte wide, so the bus passes one-byte accesses only.
impl BusDevice for I8042 {
    fn read(&mut self, offset: u64, data: &mut [u8]) {
        // Reads 0, no byte waiting and room for a command: all Linux checks.
        data.fill(self.controller.read(offset as u8));
    }

    fn write(&mut self, offset: u64, data: &[u8]) {
        if let [value] = data {
            let Ok(()) = self.controller.write(offset as u8, *value);
        }
    }
}
