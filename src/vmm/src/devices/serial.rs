// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The 8250 UART at COM1, over vm-superio's 16550A model. Guest output goes
//! to the console queue; there is no serial input yet.

use vm_superio::{
    Serial, Trigger,
    serial::{Error as UartError, NoEvents},
};

use super::console::ConsoleWriter;
use crate::{
    bus::{BusDevice, BusIo, UNCLAIMED_READ},
    error::Error,
    events::{Event, EventSender},
    io::ConfigBytes,
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

/// The serial port. Output never blocks the guest; a failed interrupt ends
/// the VM.
pub(crate) struct Serial8250 {
    uart: Serial<IrqTrigger, NoEvents, ConsoleWriter>,
    event_sender: EventSender,
    /// Whether a failed interrupt was already reported.
    irq_failed: bool,
}

impl Serial8250 {
    pub(crate) fn new(irq: IrqLine, console: ConsoleWriter, event_sender: EventSender) -> Self {
        Self {
            uart: Serial::new(IrqTrigger(irq), console),
            event_sender,
            irq_failed: false,
        }
    }
}

// The port range spans the eight UART registers, so every offset fits a `u8`.
impl BusDevice for Serial8250 {
    fn read(&mut self, offset: u64, len: usize) -> BusIo<ConfigBytes> {
        BusIo::Complete(match len {
            1 => ConfigBytes::from_slice(&[self.uart.read(offset as u8)]),
            // The registers take byte accesses only.
            _ => ConfigBytes::fill(UNCLAIMED_READ, len),
        })
    }

    fn write(&mut self, offset: u64, data: &[u8]) -> BusIo<()> {
        let [value] = data else {
            return BusIo::Complete(());
        };
        match self.uart.write(offset as u8, *value) {
            // The console queue never fails, and only input fills the FIFO.
            Ok(()) | Err(UartError::FullFifo | UartError::IOError(_)) => {}
            Err(UartError::Trigger(error)) => {
                if !std::mem::replace(&mut self.irq_failed, true) {
                    self.event_sender.send(Event::DeviceFailed(error));
                }
            }
        }
        BusIo::Complete(())
    }
}
