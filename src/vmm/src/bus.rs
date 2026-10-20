// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Address-range registration and device I/O dispatch.
//!
//! Provides [`Bus`] for address-range routing to emulated [`BusDevice`] instances,
//! and [`Buses`] for routing MMIO and port I/O exits from vCPUs.

use std::sync::{Arc, Mutex, RwLock, Weak};

use crate::error::{Error, Result};

/// Trait for emulated devices that respond to reads and writes within an assigned range.
///
/// Devices receive offsets relative to their registered base address.
pub(crate) trait BusDevice: Send {
    /// Reads `data.len()` bytes at `offset` from the device's base address.
    fn read(&mut self, offset: u64, data: &mut [u8]);

    /// Writes `data` at `offset` from the device's base address.
    fn write(&mut self, offset: u64, data: &[u8]);
}

/// A contiguous address range registered on a [`Bus`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct BusRange {
    base: u64,
    len: u64,
}

impl BusRange {
    /// Creates a new range from base address and byte length.
    ///
    /// Returns [`Error::Overlap`] if `len` is zero or the range wraps around `u64::MAX`.
    pub(crate) fn new(base: u64, len: u64) -> Result<Self> {
        if len == 0 || base.checked_add(len - 1).is_none() {
            return Err(Error::Overlap);
        }
        Ok(Self { base, len })
    }

    /// The base address of the range.
    pub(crate) fn base(&self) -> u64 {
        self.base
    }

    /// The length in bytes.
    pub(crate) fn len(&self) -> u64 {
        self.len
    }

    /// The last byte address of the range (inclusive).
    pub(crate) fn end(&self) -> u64 {
        self.base + (self.len - 1)
    }

    /// Returns `true` if this range overlaps with `other`.
    pub(crate) fn overlaps(&self, other: &Self) -> bool {
        self.base <= other.end() && other.base <= self.end()
    }

    /// Returns `true` if this range completely contains `[start, start + len - 1]`.
    pub(crate) fn contains_range(&self, start: u64, len: u64) -> bool {
        if len == 0 {
            return false;
        }
        match start.checked_add(len - 1) {
            Some(end) => start >= self.base && end <= self.end(),
            None => false,
        }
    }
}

type BusEntry = (BusRange, Weak<Mutex<dyn BusDevice>>);

/// A container that routes memory-mapped or port I/O accesses to registered devices.
///
/// Devices are held via [`Weak`] references so the bus does not extend their lifetime.
#[derive(Default)]
pub(crate) struct Bus {
    devices: RwLock<Vec<BusEntry>>,
}

impl std::fmt::Debug for Bus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let devices = self.devices.read().unwrap();
        f.debug_list()
            .entries(devices.iter().map(|(r, _)| r))
            .finish()
    }
}

impl Bus {
    /// Creates an empty bus.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Registers a device for the specified range.
    ///
    /// Returns [`Error::Overlap`] if the range overlaps with any existing registration.
    pub(crate) fn insert(&self, range: BusRange, device: Arc<Mutex<dyn BusDevice>>) -> Result<()> {
        let mut devices = self.devices.write().unwrap();
        for (existing, _) in devices.iter() {
            if existing.overlaps(&range) {
                return Err(Error::Overlap);
            }
        }
        devices.push((range, Arc::downgrade(&device)));
        Ok(())
    }

    /// Reads `data.len()` bytes at `addr`.
    ///
    /// Unclaimed, dead, or partial accesses fill `data` with `0xFF`.
    pub(crate) fn read(&self, addr: u64, data: &mut [u8]) {
        if data.is_empty() {
            return;
        }
        let len = data.len() as u64;
        let devices = self.devices.read().unwrap();
        for (range, weak) in devices.iter() {
            if range.contains_range(addr, len) {
                if let Some(arc) = weak.upgrade() {
                    data.fill(0);
                    let offset = addr - range.base();
                    arc.lock().unwrap().read(offset, data);
                    return;
                }
                data.fill(0xFF);
                return;
            }
        }
        data.fill(0xFF);
    }

    /// Writes `data` to `addr`.
    ///
    /// Unclaimed, dead, or partial accesses drop the written bytes.
    pub(crate) fn write(&self, addr: u64, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let len = data.len() as u64;
        let devices = self.devices.read().unwrap();
        for (range, weak) in devices.iter() {
            if range.contains_range(addr, len) {
                if let Some(arc) = weak.upgrade() {
                    let offset = addr - range.base();
                    arc.lock().unwrap().write(offset, data);
                    return;
                }
                return;
            }
        }
    }
}

/// The set of I/O buses for a virtual machine.
///
/// Contains an MMIO bus, plus a port I/O bus on x86_64.
#[derive(Default)]
pub(crate) struct Buses {
    pub(crate) mmio: Bus,
    #[cfg(target_arch = "x86_64")]
    pub(crate) io: Bus,
}

impl std::fmt::Debug for Buses {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut d = f.debug_struct("Buses");
        d.field("mmio", &self.mmio);
        #[cfg(target_arch = "x86_64")]
        d.field("io", &self.io);
        d.finish()
    }
}

impl Buses {
    /// Creates empty MMIO (and port I/O) buses.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Dispatches a vCPU exit to the matching bus.
    ///
    /// MMIO and port I/O accesses are handled and return `None`.
    /// Other exits return `Some(exit)` to the caller.
    pub(crate) fn dispatch<'a>(
        &self,
        exit: boxlite_hypervisor::VcpuExit<'a>,
    ) -> Option<boxlite_hypervisor::VcpuExit<'a>> {
        match exit {
            boxlite_hypervisor::VcpuExit::MmioRead { guest_addr, bytes } => {
                self.mmio.read(guest_addr, bytes);
                None
            }
            boxlite_hypervisor::VcpuExit::MmioWrite { guest_addr, bytes } => {
                self.mmio.write(guest_addr, bytes);
                None
            }
            #[cfg(target_arch = "x86_64")]
            boxlite_hypervisor::VcpuExit::IoIn { port, bytes } => {
                self.io.read(u64::from(port), bytes);
                None
            }
            #[cfg(target_arch = "x86_64")]
            boxlite_hypervisor::VcpuExit::IoOut { port, bytes } => {
                self.io.write(u64::from(port), bytes);
                None
            }
            other => Some(other),
        }
    }
}

#[cfg(test)]
#[path = "../tests/bus/mod.rs"]
mod tests;
