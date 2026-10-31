// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Address-range registration and device I/O dispatch.
//!
//! A [`Bus`] maps non-overlapping ranges to devices. It is filled while the
//! machine is built and names every owner, so a conflict is reported with
//! both sides. After the build the bus never changes: lookups take no lock,
//! and the table holds the devices' strong references.
//!
//! A device may finish an access immediately ([`BusIo::Complete`]) or hand
//! back a completion ([`BusIo::Deferred`]). The bus turns the latter into a
//! [`ReadIo`] or [`WriteIo`] that the run thread retries with
//! [`BusDevice::progress`]; the vCPU waits on the completion.

use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
};

use boxlite_hypervisor::VcpuExit;

use crate::io::{Completer, Completion, ConfigBytes};

/// What a read returns when no device claims the whole access, as on a PC bus
/// with nothing driving the data lines.
pub(crate) const UNCLAIMED_READ: u8 = 0xff;

/// The result of one device access.
#[derive(Debug)]
pub(crate) enum BusIo<T> {
    /// The device completed the access.
    Complete(T),
    /// The access is pending; the completion fires when the run thread may
    /// call [`BusDevice::progress`].
    Deferred(Completion<()>),
}

/// The work the run thread repeats for a deferred access.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PendingIo {
    /// A read of `len` bytes at `offset`; `bytes` is filled on completion.
    Read {
        offset: u64,
        len: usize,
        bytes: Option<ConfigBytes>,
    },
    /// A write at `offset`; the data was copied when the device deferred.
    Write { offset: u64, data: Vec<u8> },
}

/// A device on a bus. `offset` is relative to the device's register window.
pub(crate) trait BusDevice: Send {
    /// Reads `len` bytes at `offset`.
    fn read(&mut self, offset: u64, len: usize) -> BusIo<ConfigBytes>;
    /// Writes `data` at `offset`.
    fn write(&mut self, offset: u64, data: &[u8]) -> BusIo<()>;
    /// Advances a deferred access. The default completes it at once. A
    /// device that cannot finish hands back a fresh readiness completion,
    /// which replaces the previous one and must be completed, not dropped
    /// or cancelled, when the access may make progress.
    fn progress(&mut self, _request: &mut PendingIo) -> BusIo<()> {
        BusIo::Complete(())
    }
}

/// A read the run thread must retry.
pub(crate) struct ReadIo {
    target: Arc<Mutex<dyn BusDevice>>,
    offset: u64,
    len: usize,
    readiness: Completion<()>,
    completion: Completion<ConfigBytes>,
    completer: Completer<ConfigBytes>,
}

/// A write the run thread must retry.
pub(crate) struct WriteIo {
    target: Arc<Mutex<dyn BusDevice>>,
    offset: u64,
    data: Vec<u8>,
    readiness: Completion<()>,
    completion: Completion<()>,
    completer: Completer<()>,
}

/// A deferred access of either kind, as the control queue stores it.
pub(crate) enum DeferredIo {
    Read(ReadIo),
    Write(WriteIo),
}

impl ReadIo {
    /// The vCPU's completion.
    pub(crate) fn completion(&self) -> Completion<ConfigBytes> {
        self.completion.clone()
    }

    /// The device's readiness completion.
    pub(crate) fn readiness(&self) -> Completion<()> {
        self.readiness.clone()
    }

    /// The request the run thread passes to [`BusDevice::progress`].
    pub(crate) fn request(&self) -> PendingIo {
        PendingIo::Read {
            offset: self.offset,
            len: self.len,
            bytes: None,
        }
    }

    /// Locks the device for one progress call; `None` if the device panicked
    /// while another access held it, so the access can never finish.
    pub(crate) fn lock_target(&self) -> Option<MutexGuard<'_, dyn BusDevice + 'static>> {
        self.target.lock().ok()
    }

    /// Delivers the read result; a missing result reads as zeros.
    pub(crate) fn complete(self, request: PendingIo) -> bool {
        let PendingIo::Read { bytes, .. } = request else {
            return false;
        };
        self.completer
            .complete(bytes.unwrap_or_else(|| ConfigBytes::new(self.len)))
    }
}

impl WriteIo {
    /// The vCPU's completion.
    pub(crate) fn completion(&self) -> Completion<()> {
        self.completion.clone()
    }

    /// The device's readiness completion.
    pub(crate) fn readiness(&self) -> Completion<()> {
        self.readiness.clone()
    }

    /// The request the run thread passes to [`BusDevice::progress`].
    pub(crate) fn request(&self) -> PendingIo {
        PendingIo::Write {
            offset: self.offset,
            data: self.data.clone(),
        }
    }

    /// Locks the device for one progress call; `None` if the device panicked
    /// while another access held it, so the access can never finish.
    pub(crate) fn lock_target(&self) -> Option<MutexGuard<'_, dyn BusDevice + 'static>> {
        self.target.lock().ok()
    }

    /// Completes the write.
    pub(crate) fn complete(self, request: PendingIo) -> bool {
        matches!(request, PendingIo::Write { .. }) && self.completer.complete(())
    }
}

impl DeferredIo {
    /// The device's readiness completion.
    pub(crate) fn readiness(&self) -> Completion<()> {
        match self {
            Self::Read(io) => io.readiness(),
            Self::Write(io) => io.readiness(),
        }
    }

    /// Replaces the readiness the next wait arms.
    pub(crate) fn set_readiness(&mut self, readiness: Completion<()>) {
        match self {
            Self::Read(io) => io.readiness = readiness,
            Self::Write(io) => io.readiness = readiness,
        }
    }

    /// The request the run thread passes to [`BusDevice::progress`].
    pub(crate) fn request(&self) -> PendingIo {
        match self {
            Self::Read(io) => io.request(),
            Self::Write(io) => io.request(),
        }
    }

    /// Locks the device for one progress call; `None` if the device panicked
    /// while another access held it.
    pub(crate) fn lock_target(&self) -> Option<MutexGuard<'_, dyn BusDevice + 'static>> {
        match self {
            Self::Read(io) => io.lock_target(),
            Self::Write(io) => io.lock_target(),
        }
    }

    /// Delivers the result.
    pub(crate) fn complete(self, request: PendingIo) -> bool {
        match self {
            Self::Read(io) => io.complete(request),
            Self::Write(io) => io.complete(request),
        }
    }

    /// Cancels the access and wakes its waiter.
    pub(crate) fn cancel(self) -> bool {
        match self {
            Self::Read(io) => io.completer.cancel(),
            Self::Write(io) => io.completer.cancel(),
        }
    }
}

/// The immediate or deferred answer to a bus read.
pub(crate) enum BusRead {
    /// The bytes.
    Complete(ConfigBytes),
    /// The access is pending.
    Deferred(ReadIo),
}

/// The immediate or deferred answer to a bus write.
pub(crate) enum BusWrite {
    /// The write finished.
    Complete,
    /// The access is pending.
    Deferred(WriteIo),
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
pub(crate) type Target = (Arc<Mutex<dyn BusDevice>>, u64);

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

    /// Reads `len` bytes at `addr`. An access that no device holds entirely
    /// reads as [`UNCLAIMED_READ`] and is counted.
    pub(crate) fn read(&self, addr: u64, len: usize) -> BusRead {
        match self.device(addr, len) {
            Some((target, offset)) => {
                let mut device = lock(&target.0);
                match device.read(offset, len) {
                    BusIo::Complete(bytes) => BusRead::Complete(bytes),
                    BusIo::Deferred(readiness) => {
                        let (completion, completer) = Completion::new();
                        BusRead::Deferred(ReadIo {
                            target: Arc::clone(&target.0),
                            offset,
                            len,
                            readiness,
                            completion,
                            completer,
                        })
                    }
                }
            }
            None => {
                self.unclaimed_reads.fetch_add(1, Ordering::Relaxed);
                BusRead::Complete(ConfigBytes::fill(UNCLAIMED_READ, len))
            }
        }
    }

    /// Writes `data` at `addr`. An access that no device holds entirely is
    /// dropped and counted.
    pub(crate) fn write(&self, addr: u64, data: &[u8]) -> BusWrite {
        match self.device(addr, data.len()) {
            Some((target, offset)) => {
                let mut device = lock(&target.0);
                match device.write(offset, data) {
                    BusIo::Complete(()) => BusWrite::Complete,
                    BusIo::Deferred(readiness) => {
                        let (completion, completer) = Completion::new();
                        BusWrite::Deferred(WriteIo {
                            target: Arc::clone(&target.0),
                            offset,
                            data: data.to_vec(),
                            readiness,
                            completion,
                            completer,
                        })
                    }
                }
            }
            None => {
                self.unclaimed_writes.fetch_add(1, Ordering::Relaxed);
                BusWrite::Complete
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
    fn device(&self, addr: u64, len: usize) -> Option<(&Target, u64)> {
        let (_, entry) = self.ranges.range(..=addr).next_back()?;
        if !entry.range.holds(addr, len) {
            return None;
        }
        let target = entry.target.as_ref()?;
        Some((target, target.1 + (addr - entry.range.base)))
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

/// The answer to one [`VcpuExit`]: handled, returned, or deferred.
pub(crate) enum Dispatch<'a> {
    /// The bus served the access.
    Handled,
    /// The exit is not a bus access.
    Passthrough(VcpuExit<'a>),
    /// A read the vCPU must wait on.
    DeferredRead {
        /// The exit whose buffer receives the bytes.
        exit: VcpuExit<'a>,
        /// The vCPU's completion.
        completion: Completion<ConfigBytes>,
        /// The work the run thread retries.
        io: ReadIo,
    },
    /// A write the vCPU must wait on.
    DeferredWrite {
        /// The vCPU's completion.
        completion: Completion<()>,
        /// The work the run thread retries.
        io: WriteIo,
    },
}

/// The buses a vCPU dispatches to: MMIO on every host, plus port I/O on x86_64.
#[derive(Default)]
pub(crate) struct Buses {
    pub(crate) mmio: Bus,
    #[cfg(target_arch = "x86_64")]
    pub(crate) pio: Bus,
}

impl Buses {
    /// Serves an MMIO or port access, or returns the exit unchanged.
    pub(crate) fn dispatch<'a>(&self, exit: VcpuExit<'a>) -> Dispatch<'a> {
        match exit {
            VcpuExit::MmioRead { guest_addr, bytes } => {
                match self.mmio.read(guest_addr, bytes.len()) {
                    BusRead::Complete(config) => {
                        bytes.copy_from_slice(config.as_slice());
                        Dispatch::Handled
                    }
                    BusRead::Deferred(io) => {
                        let completion = io.completion();
                        Dispatch::DeferredRead {
                            exit: VcpuExit::MmioRead { guest_addr, bytes },
                            completion,
                            io,
                        }
                    }
                }
            }
            VcpuExit::MmioWrite { guest_addr, bytes } => match self.mmio.write(guest_addr, bytes) {
                BusWrite::Complete => Dispatch::Handled,
                BusWrite::Deferred(io) => Dispatch::DeferredWrite {
                    completion: io.completion(),
                    io,
                },
            },
            #[cfg(target_arch = "x86_64")]
            VcpuExit::IoIn { port, bytes } => match self.pio.read(port.into(), bytes.len()) {
                BusRead::Complete(config) => {
                    bytes.copy_from_slice(config.as_slice());
                    Dispatch::Handled
                }
                BusRead::Deferred(io) => {
                    let completion = io.completion();
                    Dispatch::DeferredRead {
                        exit: VcpuExit::IoIn { port, bytes },
                        completion,
                        io,
                    }
                }
            },
            #[cfg(target_arch = "x86_64")]
            VcpuExit::IoOut { port, bytes } => match self.pio.write(port.into(), bytes) {
                BusWrite::Complete => Dispatch::Handled,
                BusWrite::Deferred(io) => Dispatch::DeferredWrite {
                    completion: io.completion(),
                    io,
                },
            },
            other => Dispatch::Passthrough(other),
        }
    }
}

#[cfg(test)]
#[path = "../tests/bus/mod.rs"]
mod tests;
