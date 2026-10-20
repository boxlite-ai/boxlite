// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The 8250 UART at COM1, over vm-superio's 16550A model. Guest output goes
//! to a host sink; there is no serial input yet.

use std::io::Write;

use vm_superio::{
    Serial, Trigger,
    serial::{Error as UartError, NoEvents},
};

use crate::{
    bus::{BusDevice, UNCLAIMED_READ},
    error::Error,
    events::{Event, EventSender},
    irq::IrqLine,
};

/// Raises the UART interrupt as an edge on its line.
struct IrqTrigger(IrqLine);

impl Trigger for IrqTrigger {
    type E = Error;

    fn trigger(&self) -> Result<(), Error> {
        self.0.pulse()
    }
}

/// The serial port. A failed sink write drops the byte; a failed interrupt
/// ends the VM.
pub(crate) struct Serial8250 {
    uart: Serial<IrqTrigger, NoEvents, Box<dyn Write + Send>>,
    events: EventSender,
    /// Output bytes the sink failed to take.
    dropped_bytes: u64,
    /// Whether a failed interrupt was already reported.
    failed: bool,
}

impl Serial8250 {
    pub(crate) fn new(irq: IrqLine, out: Box<dyn Write + Send>, events: EventSender) -> Self {
        Self {
            uart: Serial::new(IrqTrigger(irq), out),
            events,
            dropped_bytes: 0,
            failed: false,
        }
    }

    pub(crate) fn dropped_bytes(&self) -> u64 {
        self.dropped_bytes
    }
}

// The port range spans the eight UART registers, so every offset fits a `u8`.
impl BusDevice for Serial8250 {
    fn read(&mut self, offset: u64, data: &mut [u8]) {
        match data {
            [value] => *value = self.uart.read(offset as u8),
            // The registers take byte accesses only.
            data => data.fill(UNCLAIMED_READ),
        }
    }

    fn write(&mut self, offset: u64, data: &[u8]) {
        let [value] = data else { return };
        match self.uart.write(offset as u8, *value) {
            // Only queueing input reports a full FIFO.
            Ok(()) | Err(UartError::FullFifo) => {}
            // vm-superio raised THRE before reporting the failed write, so the
            // guest keeps sending and loses only this byte.
            Err(UartError::IOError(_)) => self.dropped_bytes += 1,
            Err(UartError::Trigger(error)) => {
                if !std::mem::replace(&mut self.failed, true) {
                    self.events.send(Event::DeviceFailed(error));
                }
            }
        }
    }
}
