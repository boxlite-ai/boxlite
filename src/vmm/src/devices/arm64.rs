// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The arm64 platform: the windows the host's in-kernel GICv3 serves, and the
//! PL011 console, at the addresses the device tree names. The layout follows
//! Firecracker's, with RAM at `0x8000_0000` (design #2103).

use super::{console::ConsoleWriter, pl011::Pl011};
use crate::{
    chipset::{BusKind, ChipsetBuilder},
    error::Result,
};

/// The GICv3 distributor, 64 KiB.
pub(crate) const GICD_BASE: u64 = 0x3fff_0000;
pub(crate) const GICD_SIZE: u64 = 0x1_0000;
/// The redistributor window below the distributor: HVF sizes its region for
/// every vCPU it supports, 32 MiB on macOS 27, whatever the vCPU count.
pub(crate) const GICR_BASE: u64 = 0x3dff_0000;
/// One vCPU's redistributor: its RD and SGI frames, 64 KiB each.
pub(crate) const GICR_FRAME_SIZE: u64 = 0x2_0000;
/// The PL011 in Firecracker's serial slot, on the first SPI.
pub(crate) const PL011_BASE: u64 = 0x4000_2000;
pub(crate) const PL011_SIZE: u64 = 0x1000;
pub(crate) const PL011_SPI: u32 = 32;

/// Reserves the GIC windows, so a device placed there fails the build, then
/// adds the PL011 writing to `console`.
pub(crate) fn add_platform_devices(
    builder: &mut ChipsetBuilder,
    console: ConsoleWriter,
) -> Result<()> {
    builder.reserve(
        BusKind::Mmio,
        GICD_BASE,
        GICD_SIZE,
        "in-kernel GIC distributor",
    );
    builder.reserve(
        BusKind::Mmio,
        GICR_BASE,
        GICD_BASE - GICR_BASE,
        "in-kernel GIC redistributors",
    );
    builder.add("pl011", |r| {
        r.mmio(PL011_BASE, PL011_SIZE);
        Ok(Pl011::new(r.line(PL011_SPI), console, r.event_sender()))
    })
}

#[cfg(test)]
#[path = "../../tests/arm64_devices/mod.rs"]
mod tests;
