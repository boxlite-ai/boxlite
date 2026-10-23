// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The x86_64 legacy platform: the PC ports Linux expects at boot, and
//! the windows KVM's in-kernel PIC, PIT and APICs serve.

use super::{
    cmos::{Clock, CmosRtc},
    console::ConsoleWriter,
    i8042::I8042,
    serial::Serial8250,
};
use crate::{
    chipset::{BusKind, ChipsetBuilder},
    error::Result,
};

// COM1 and the interrupt line (GSI) it raises, the CMOS index port, whose
// data port follows it, then the i8042 data and command ports.
pub(crate) const COM1: u64 = 0x3f8;
pub(crate) const COM1_GSI: u32 = 4;
pub(crate) const CMOS: u64 = 0x70;
pub(crate) const I8042_DATA: u64 = 0x60;
pub(crate) const I8042_COMMAND: u64 = 0x64;

/// Reserves the windows the host serves in the kernel, so a device placed
/// there fails the build, then adds COM1 on GSI 4, writing to `console`, the
/// CMOS RTC, which reads the time from `clock`, and the i8042, whose reset
/// ends the VM.
pub(crate) fn add_legacy_devices(
    builder: &mut ChipsetBuilder,
    console: ConsoleWriter,
    clock: Clock,
) -> Result<()> {
    for (base, len, owner) in [
        (0x20, 2, "in-kernel PIC"),
        (0xa0, 2, "in-kernel PIC"),
        (0x4d0, 2, "in-kernel PIC"),
        (0x40, 4, "in-kernel PIT"),
        (0x61, 1, "in-kernel PIT"),
    ] {
        builder.reserve(BusKind::Pio, base, len, owner);
    }
    builder.reserve(BusKind::Mmio, 0xfec0_0000, 0x1000, "in-kernel IOAPIC");
    builder.reserve(BusKind::Mmio, 0xfee0_0000, 0x1000, "in-kernel local APIC");

    builder.add("com1", |r| {
        r.pio(COM1, 8);
        Ok(Serial8250::new(r.line(COM1_GSI), console, r.event_sender()))
    })?;
    builder.add("cmos", |r| {
        r.pio(CMOS, 2);
        Ok(CmosRtc::new(clock))
    })?;
    builder.add("i8042", |r| {
        r.pio(I8042_DATA, 1);
        r.pio_with_offset(I8042_COMMAND, 1, 4);
        Ok(I8042::new(r.event_sender()))
    })
}

#[cfg(test)]
#[path = "../../tests/devices/mod.rs"]
mod tests;
