// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The PL011 UART (Arm PrimeCell UART TRM, DDI0183), output only: a write to
//! the data register goes to the console queue at once, so the transmit FIFO
//! is never full and its interrupt is pending whenever the guest unmasks it.
//! There is no serial input yet.

use std::io::Write;

use super::console::ConsoleWriter;
use crate::{
    bus::{BusDevice, UNCLAIMED_READ},
    events::{Event, EventSender},
    irq::IrqLine,
};

// Register offsets (DDI0183, table 3-1).
const DR: u64 = 0x000;
const FR: u64 = 0x018;
const ILPR: u64 = 0x020;
const IBRD: u64 = 0x024;
const FBRD: u64 = 0x028;
const LCR_H: u64 = 0x02c;
const CR: u64 = 0x030;
const IFLS: u64 = 0x034;
const IMSC: u64 = 0x038;
const RIS: u64 = 0x03c;
const MIS: u64 = 0x040;
const ICR: u64 = 0x044;
const DMACR: u64 = 0x048;
/// PeriphID0-3, then PCellID0-3: part 0x011, designer Arm, revision 1, and
/// the PrimeCell signature, one byte per 32-bit register.
const ID_START: u64 = 0xfe0;
const ID_END: u64 = 0xffc;
const ID: [u8; 8] = [0x11, 0x10, 0x14, 0x00, 0x0d, 0xf0, 0x05, 0xb1];

/// FR: the receive and transmit FIFOs are empty.
const FR_RXFE: u32 = 1 << 4;
const FR_TXFE: u32 = 1 << 7;
/// The transmit interrupt bit in IMSC, RIS, MIS and ICR.
const INT_TX: u32 = 1 << 5;
/// Reset values: TXE and RXE set in CR; half-full FIFO levels in IFLS.
const CR_RESET: u32 = 0x300;
const IFLS_RESET: u32 = 0x12;

/// The serial port. Output never blocks the guest; a failed interrupt ends
/// the VM.
pub(crate) struct Pl011 {
    irq: IrqLine,
    console: ConsoleWriter,
    event_sender: EventSender,
    /// Whether a failed interrupt was already reported.
    irq_failed: bool,
    // The registers Linux programs, each 16 bits wide or less.
    ilpr: u32,
    ibrd: u32,
    fbrd: u32,
    lcr_h: u32,
    cr: u32,
    ifls: u32,
    imsc: u32,
    dmacr: u32,
}

impl Pl011 {
    pub(crate) fn new(irq: IrqLine, console: ConsoleWriter, event_sender: EventSender) -> Self {
        Self {
            irq,
            console,
            event_sender,
            irq_failed: false,
            ilpr: 0,
            ibrd: 0,
            fbrd: 0,
            lcr_h: 0,
            cr: CR_RESET,
            ifls: IFLS_RESET,
            imsc: 0,
            dmacr: 0,
        }
    }

    fn register(&self, offset: u64) -> u32 {
        match offset {
            // No input yet, so the receive FIFO is always empty.
            DR => 0,
            FR => FR_TXFE | FR_RXFE,
            ILPR => self.ilpr,
            IBRD => self.ibrd,
            FBRD => self.fbrd,
            LCR_H => self.lcr_h,
            CR => self.cr,
            IFLS => self.ifls,
            IMSC => self.imsc,
            // Output leaves at once, so the transmit FIFO always wants data.
            RIS => INT_TX,
            MIS => INT_TX & self.imsc,
            DMACR => self.dmacr,
            ID_START..=ID_END if offset.is_multiple_of(4) => {
                ID[((offset - ID_START) / 4) as usize].into()
            }
            _ => 0,
        }
    }

    /// Holds the line at the masked transmit interrupt. A failure is
    /// reported once; the VM is ending anyway.
    fn update_irq(&mut self) {
        if let Err(error) = self.irq.set_level(INT_TX & self.imsc != 0)
            && !std::mem::replace(&mut self.irq_failed, true)
        {
            self.event_sender.send(Event::DeviceFailed(error));
        }
    }
}

// Linux reads the identification with 32-bit accesses and the other
// registers with 16-bit ones; earlycon writes the data register a byte at a
// time.
impl BusDevice for Pl011 {
    fn read(&mut self, offset: u64, data: &mut [u8]) {
        if !matches!(data.len(), 1 | 2 | 4) {
            data.fill(UNCLAIMED_READ);
            return;
        }
        data.copy_from_slice(&self.register(offset).to_le_bytes()[..data.len()]);
    }

    fn write(&mut self, offset: u64, data: &[u8]) {
        if !matches!(data.len(), 1 | 2 | 4) {
            return;
        }
        let mut bytes = [0; 4];
        bytes[..data.len()].copy_from_slice(data);
        let value = u32::from_le_bytes(bytes) & 0xffff;
        match offset {
            // The console queue takes every byte; when full it drops the
            // oldest output instead of failing.
            DR => {
                let _ = self.console.write_all(&[value as u8]);
            }
            ILPR => self.ilpr = value,
            IBRD => self.ibrd = value,
            FBRD => self.fbrd = value,
            LCR_H => self.lcr_h = value,
            CR => self.cr = value,
            IFLS => self.ifls = value,
            IMSC => {
                self.imsc = value;
                self.update_irq();
            }
            // The transmit FIFO stays ready, so clearing its interrupt
            // changes nothing, and there are no other sources.
            ICR => {}
            DMACR => self.dmacr = value,
            _ => {}
        }
    }
}
