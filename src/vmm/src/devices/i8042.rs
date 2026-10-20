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
/// first reset ends the VM, and Linux writes ten.
struct ResetTrigger {
    events: EventSender,
    sent: Cell<bool>,
}

impl Trigger for ResetTrigger {
    type E = Infallible;

    fn trigger(&self) -> Result<(), Infallible> {
        if !self.sent.replace(true) {
            self.events.send(Event::GuestReset);
        }
        Ok(())
    }
}

/// One i8042 port, `register` bytes above the data port 0x60: the data port
/// itself, or the command and status port 0x64. The ports between them are
/// not the i8042's: 0x61 belongs to the PIT. vm-superio's controller keeps no
/// state, so each port holds its own.
pub(crate) struct I8042Port {
    controller: I8042Device<ResetTrigger>,
    register: u8,
}

impl I8042Port {
    pub(crate) fn new(register: u8, events: EventSender) -> Self {
        Self {
            controller: I8042Device::new(ResetTrigger {
                events,
                sent: Cell::new(false),
            }),
            register,
        }
    }
}

// Each port is one byte wide, so the bus passes one-byte accesses only.
impl BusDevice for I8042Port {
    fn read(&mut self, _offset: u64, data: &mut [u8]) {
        // Reads 0: no byte waiting and room for a command, which is all Linux
        // checks before it sends the reset.
        data.fill(self.controller.read(self.register));
    }

    fn write(&mut self, _offset: u64, data: &[u8]) {
        if let [value] = data {
            let Ok(()) = self.controller.write(self.register, *value);
        }
    }
}
