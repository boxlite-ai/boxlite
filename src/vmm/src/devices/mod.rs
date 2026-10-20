// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The x86_64 legacy devices the guest reaches through the port bus, and the
//! [`DeviceManager`] that owns them.

pub(crate) mod cmos;
pub(crate) mod i8042;
pub(crate) mod serial;

use std::{
    io::Write,
    sync::{Arc, Mutex},
};

use self::{
    cmos::{Clock, CmosRtc},
    i8042::I8042Port,
    serial::Serial8250,
};
use crate::{
    bus::{BusDevice, BusRange, Buses},
    error::Result,
    events::EventSender,
    irq::{IrqChip, IrqLine},
};

/// The first serial port, and the GSI of its interrupt.
const COM1: u64 = 0x3f8;
const COM1_GSI: u32 = 4;
/// The CMOS index port; the data port follows it.
const CMOS: u64 = 0x70;
/// The i8042 data and command ports, vm-superio's registers 0 and 4.
const I8042_DATA: u64 = 0x60;
const I8042_COMMAND: u64 = 0x64;

/// Owns the x86_64 legacy devices; the port bus holds only weak references.
pub(crate) struct DeviceManager {
    serial: Arc<Mutex<Serial8250>>,
    /// Every registered device, the serial port included, kept alive here.
    _devices: [Arc<Mutex<dyn BusDevice>>; 4],
}

impl DeviceManager {
    /// Creates the devices and registers them on the port bus: the serial
    /// port at COM1, raising GSI 4 through `irqs` and writing guest output to
    /// `serial_out`; the CMOS RTC on `clock`; and the i8042 data and command
    /// ports. The guest reset and device failures go to `events`.
    pub(crate) fn new(
        buses: &mut Buses,
        irqs: Arc<dyn IrqChip>,
        events: &EventSender,
        serial_out: Box<dyn Write + Send>,
        clock: Clock,
    ) -> Result<Self> {
        let serial = Arc::new(Mutex::new(Serial8250::new(
            IrqLine::new(irqs, COM1_GSI),
            serial_out,
            events.clone(),
        )));
        let i8042 = |register| Arc::new(Mutex::new(I8042Port::new(register, events.clone())));
        let devices = [
            register(buses, COM1, 8, serial.clone())?,
            register(buses, CMOS, 2, Arc::new(Mutex::new(CmosRtc::new(clock))))?,
            register(buses, I8042_DATA, 1, i8042(0))?,
            register(buses, I8042_COMMAND, 1, i8042(4))?,
        ];
        Ok(Self {
            serial,
            _devices: devices,
        })
    }

    /// Guest serial output bytes the sink failed to take.
    pub(crate) fn serial_dropped_bytes(&self) -> u64 {
        self.serial
            .lock()
            .expect("the serial port panicked during an earlier access")
            .dropped_bytes()
    }
}

/// Registers `device` for the `len` ports from `base` and hands it back.
fn register(
    buses: &mut Buses,
    base: u64,
    len: u64,
    device: Arc<Mutex<dyn BusDevice>>,
) -> Result<Arc<Mutex<dyn BusDevice>>> {
    buses.pio.insert(BusRange::new(base, len)?, &device)?;
    Ok(device)
}

#[cfg(test)]
#[path = "../../tests/devices/mod.rs"]
mod tests;
