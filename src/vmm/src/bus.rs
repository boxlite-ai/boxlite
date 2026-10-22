// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Address-range registration and device I/O dispatch.
//!
//! A [`Bus`] maps non-overlapping ranges to devices. It is filled while the
//! machine is built and names every owner, so a conflict is reported with
//! both sides. After the build the bus never changes: lookups take no lock,
//! and the table holds the devices' strong references.

use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
};

use boxlite_hypervisor::VcpuExit;

/// What a read returns when no device claims the whole access, as on a PC bus
/// with nothing driving the data lines.
pub(crate) const UNCLAIMED_READ: u8 = 0xff;

/// A device on a bus. `offset` is relative to the device's register window,
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
    /// `len` addresses from `base`, or `None` for an empty or wrapping range.
    pub(crate) fn new(base: u64, len: u64) -> Option<Self> {
        len.checked_sub(1)
            .and_then(|span| base.checked_add(span))
            .map(|last| Self { base, last })
    }

    /// Whether the access `[addr, addr + len)` lies entirely in this range.
    fn holds(&self, addr: u64, len: usize) -> bool {
        (len as u64)
            .checked_sub(1)
            .and_then(|span| addr.checked_add(span))
            .is_some_and(|end| self.base <= addr && end <= self.last)
    }
}

/// A device behind a range, and the register offset it sees at the range base.
type Target = (Arc<Mutex<dyn BusDevice>>, u64);

/// One registered range: a device window, or a window the host serves in the
/// kernel, which no device may claim and which never reaches the bus.
struct Entry {
    range: BusRange,
    owner: &'static str,
    target: Option<Target>,
}

/// The devices in one address space, keyed by range base.
#[derive(Default)]
pub(crate) struct Bus {
    ranges: BTreeMap<u64, Entry>,
    unclaimed_reads: AtomicU64,
    unclaimed_writes: AtomicU64,
}

impl Bus {
    /// Registers `range` for `owner`. With a `target`, the device sees its
    /// register offset at the range base; `None` reserves the range for a
    /// window the host serves in the kernel. Fails with the owner of the
    /// registered range the new one overlaps.
    pub(crate) fn insert(
        &mut self,
        range: BusRange,
        owner: &'static str,
        target: Option<Target>,
    ) -> Result<(), &'static str> {
        // Registered ranges never overlap, so only the one starting closest
        // below the new range's end can intersect it.
        if let Some((_, entry)) = self.ranges.range(..=range.last).next_back()
            && entry.range.last >= range.base
        {
            return Err(entry.owner);
        }
        self.ranges.insert(
            range.base,
            Entry {
                range,
                owner,
                target,
            },
        );
        Ok(())
    }

    /// Reads `data.len()` bytes at `addr`. An access that no device holds
    /// entirely reads as [`UNCLAIMED_READ`] and is counted.
    pub(crate) fn read(&self, addr: u64, data: &mut [u8]) {
        match self.device(addr, data.len()) {
            Some((device, offset)) => {
                // A device that fills only part of the buffer must not leak
                // what the hypervisor left there from an earlier exit.
                data.fill(0);
                lock(device).read(offset, data);
            }
            None => {
                self.unclaimed_reads.fetch_add(1, Ordering::Relaxed);
                data.fill(UNCLAIMED_READ);
            }
        }
    }

    /// Writes `data` at `addr`. An access that no device holds entirely is
    /// dropped and counted.
    pub(crate) fn write(&self, addr: u64, data: &[u8]) {
        match self.device(addr, data.len()) {
            Some((device, offset)) => lock(device).write(offset, data),
            None => {
                self.unclaimed_writes.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// How many reads and writes no device claimed: a guest probing for
    /// hardware the machine lacks, or a device the machine forgot.
    pub(crate) fn unclaimed(&self) -> (u64, u64) {
        (
            self.unclaimed_reads.load(Ordering::Relaxed),
            self.unclaimed_writes.load(Ordering::Relaxed),
        )
    }

    /// The device whose range holds `[addr, addr + len)`, and the register
    /// offset of `addr` in that device.
    fn device(&self, addr: u64, len: usize) -> Option<(&Mutex<dyn BusDevice>, u64)> {
        let (_, entry) = self.ranges.range(..=addr).next_back()?;
        if !entry.range.holds(addr, len) {
            return None;
        }
        let (device, offset) = entry.target.as_ref()?;
        Some((device, offset + (addr - entry.range.base)))
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
