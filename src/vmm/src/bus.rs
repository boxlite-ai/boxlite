// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Address-range registration and device I/O dispatch.
//!
//! [`Buses::dispatch`] hands an MMIO or port exit to the device whose range
//! holds the whole access, at an offset from the range base. Buses hold
//! [`Weak`] references: the device manager owns the devices, so a bus never
//! keeps one alive.

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, MutexGuard, Weak},
};

use boxlite_hypervisor::VcpuExit;

use crate::error::{Error, Result};

/// What a read returns when no device claims the whole access, as on a PC bus
/// with nothing driving the data lines.
pub(crate) const UNCLAIMED_READ: u8 = 0xff;

/// A device on a bus. `offset` is relative to the base of the device's range,
/// and the access width is the length of `data`, which may be any width.
pub(crate) trait BusDevice: Send {
    /// Fills `data` from the register at `offset`; `data` arrives zeroed.
    fn read(&mut self, offset: u64, data: &mut [u8]);
    /// Writes `data` to the register at `offset`.
    fn write(&mut self, offset: u64, data: &[u8]);
}

/// A non-empty range of bus addresses that does not wrap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BusRange {
    base: u64,
    /// The last address in the range, so a range can end at `u64::MAX`.
    last: u64,
}

impl BusRange {
    /// `len` addresses from `base`. An empty or wrapping range fails with
    /// [`Error::Overlap`].
    pub(crate) fn new(base: u64, len: u64) -> Result<Self> {
        len.checked_sub(1)
            .and_then(|span| base.checked_add(span))
            .map(|last| Self { base, last })
            .ok_or(Error::Overlap { base, len })
    }

    /// Whether the access `[addr, addr + len)` lies entirely in this range.
    fn holds(&self, addr: u64, len: usize) -> bool {
        (len as u64)
            .checked_sub(1)
            .and_then(|span| addr.checked_add(span))
            .is_some_and(|end| self.base <= addr && end <= self.last)
    }
}

/// The devices in one address space, keyed by range base.
#[derive(Default)]
pub(crate) struct Bus {
    ranges: BTreeMap<u64, (BusRange, Weak<Mutex<dyn BusDevice>>)>,
}

impl Bus {
    /// Registers `device` for `range`, keeping only a weak reference. A range
    /// that overlaps a registered one fails with [`Error::Overlap`];
    /// [`BusRange::new`] already rejected empty and wrapping ranges.
    pub(crate) fn insert(
        &mut self,
        range: BusRange,
        device: &Arc<Mutex<dyn BusDevice>>,
    ) -> Result<()> {
        // Registered ranges never overlap, so only the one starting closest
        // below the new range's end can intersect it.
        let overlaps = self
            .ranges
            .range(..=range.last)
            .next_back()
            .is_some_and(|(_, (registered, _))| registered.last >= range.base);
        if overlaps {
            return Err(Error::Overlap {
                base: range.base,
                len: range.last - range.base + 1,
            });
        }
        self.ranges
            .insert(range.base, (range, Arc::downgrade(device)));
        Ok(())
    }

    /// Reads `data.len()` bytes at `addr`. An access that no live device holds
    /// entirely reads as [`UNCLAIMED_READ`].
    pub(crate) fn read(&self, addr: u64, data: &mut [u8]) {
        match self.device(addr, data.len()) {
            Some((device, offset)) => {
                // A device that fills only part of the buffer must not leak
                // what the hypervisor left there from an earlier exit.
                data.fill(0);
                lock(&device).read(offset, data);
            }
            None => data.fill(UNCLAIMED_READ),
        }
    }

    /// Writes `data` at `addr`. An access that no live device holds entirely
    /// is dropped.
    pub(crate) fn write(&self, addr: u64, data: &[u8]) {
        if let Some((device, offset)) = self.device(addr, data.len()) {
            lock(&device).write(offset, data);
        }
    }

    /// The live device whose range holds `[addr, addr + len)`, and the offset
    /// of `addr` in that range.
    fn device(&self, addr: u64, len: usize) -> Option<(Arc<Mutex<dyn BusDevice>>, u64)> {
        let (_, (range, device)) = self.ranges.range(..=addr).next_back()?;
        if !range.holds(addr, len) {
            return None;
        }
        Some((device.upgrade()?, addr - range.base))
    }
}

/// Locks `device`. A poisoned lock means an earlier access panicked, which is
/// a VMM bug rather than guest input, so this access stops too, as in
/// Firecracker's and cloud-hypervisor's buses.
fn lock<'a>(device: &'a Mutex<dyn BusDevice + 'static>) -> MutexGuard<'a, dyn BusDevice + 'static> {
    device
        .lock()
        .expect("a bus device panicked during an earlier access")
}

/// The buses a vCPU dispatches to: MMIO on every host, plus port I/O on x86_64.
#[derive(Default)]
pub(crate) struct Buses {
    pub(crate) mmio: Bus,
    #[cfg(target_arch = "x86_64")]
    pub(crate) pio: Bus,
}

impl Buses {
    /// Serves an MMIO or port access and returns `None`; returns every other
    /// exit to the caller unchanged.
    pub(crate) fn dispatch<'a>(&self, exit: VcpuExit<'a>) -> Option<VcpuExit<'a>> {
        match exit {
            VcpuExit::MmioRead { guest_addr, bytes } => self.mmio.read(guest_addr, bytes),
            VcpuExit::MmioWrite { guest_addr, bytes } => self.mmio.write(guest_addr, bytes),
            #[cfg(target_arch = "x86_64")]
            VcpuExit::IoIn { port, bytes } => self.pio.read(port.into(), bytes),
            #[cfg(target_arch = "x86_64")]
            VcpuExit::IoOut { port, bytes } => self.pio.write(port.into(), bytes),
            other => return Some(other),
        }
        None
    }
}

#[cfg(test)]
#[path = "../tests/bus/mod.rs"]
mod tests;
