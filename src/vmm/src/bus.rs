// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Address-range registration and device I/O dispatch.
//!
//! Guest accesses to RAM never leave the hypervisor, so the VMM only sees
//! exits for device windows. A [`Bus`] maps those windows to [`BusDevice`]
//! implementations, and a handled `MmioRead`/`MmioWrite` (or, on x86_64, an
//! `IoIn`/`IoOut` through [`IoBus`]) is resolved here: find the window,
//! subtract its base, and call the device with the offset.
//!
//! A vCPU thread holds a device's lock for exactly one register access (see
//! the design document's locking rule in `docs/contributing/architecture/vmm/README.md`).
//! The M1 legacy devices (8250, CMOS RTC, i8042) have host-side work that
//! cannot block — writing to a sink, reading the system clock, setting an
//! atomic flag — so they are serviced inline and own no worker thread.

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use crate::error::{Error, Result};

/// The minimal face a simulated device shows to a bus: one register access.
///
/// `offset` is measured from the device's registered base address, so a
/// device never learns where it sits in the guest address space. `data`
/// carries the access: its length is the access width (1, 2, 4, or 8 bytes
/// on real hardware), and `read` fills it with the device's response.
pub trait BusDevice: Send {
    /// Reads `data.len()` bytes starting at `offset` into `data`.
    fn read(&mut self, offset: u64, data: &mut [u8]);

    /// Writes `data` starting at `offset`.
    fn write(&mut self, offset: u64, data: &[u8]);
}

/// A registered device plus the size of its window.
type Window = (u64, Arc<Mutex<dyn BusDevice + Send>>);

/// Returns whether `[start, start + len)` overlaps `[other_start, other_start + other_len)`.
///
/// Both ends are exact: `insert` rejects any window whose range would
/// overflow the address space, so every stored end — and every start or
/// size a caller may pass in under that same rule — is representable and
/// plain addition never wraps. Adjacency (one range ending where the other
/// starts) is not an overlap.
fn overlaps(start: u64, len: u64, other_start: u64, other_len: u64) -> bool {
    start < other_start + other_len && other_start < start + len
}

/// The MMIO bus: guest physical address ranges mapped to devices.
///
/// Windows are registered while the VM is built and never overlap; the
/// access path only reads the map, so it is usable from every vCPU thread
/// without further synchronization (device state stays behind each
/// window's `Mutex`).
#[derive(Default)]
pub struct Bus {
    /// key: window base; value: (size, device)
    ranges: BTreeMap<u64, Window>,
}

impl Bus {
    /// Creates an empty bus.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `device` for `[base, base + size)`.
    ///
    /// Fails with [`Error::InvalidWindow`] if `size` is zero or the range
    /// would run past the end of the address space, and with
    /// [`Error::Overlap`] if the range touches a registered window.
    pub fn insert(
        &mut self,
        base: u64,
        size: u64,
        device: Arc<Mutex<dyn BusDevice + Send>>,
    ) -> Result<()> {
        if size == 0 || base.checked_add(size).is_none() {
            return Err(Error::InvalidWindow { base, size });
        }
        if self
            .ranges
            .iter()
            .any(|(old_base, (old_size, _))| overlaps(base, size, *old_base, *old_size))
        {
            return Err(Error::Overlap { base, size });
        }
        self.ranges.insert(base, (size, device));
        Ok(())
    }

    /// Dispatches a guest read at `addr` to its device.
    ///
    /// The whole access must land in one window, as it would on real
    /// hardware; a split or unmapped access fails with [`Error::Unmapped`]
    /// and the caller reports a fatal guest exit rather than stitching two
    /// devices together.
    pub fn read(&self, addr: u64, data: &mut [u8]) -> Result<()> {
        let (base, device) = self.window(addr, data.len() as u64)?;
        let mut guard = device.lock().map_err(|_| Error::DevicePoisoned { addr })?;
        guard.read(addr - base, data);
        Ok(())
    }

    /// Dispatches a guest write at `addr` to its device. See [`Bus::read`]
    /// for the one-window rule.
    pub fn write(&self, addr: u64, data: &[u8]) -> Result<()> {
        let (base, device) = self.window(addr, data.len() as u64)?;
        let mut guard = device.lock().map_err(|_| Error::DevicePoisoned { addr })?;
        guard.write(addr - base, data);
        Ok(())
    }

    /// Finds the window whose range fully contains `[addr, addr + len)`.
    ///
    /// Windows never overlap, so the greatest base at or below `addr` is
    /// the only candidate.
    fn window(&self, addr: u64, len: u64) -> Result<(u64, &Arc<Mutex<dyn BusDevice + Send>>)> {
        let end = addr.checked_add(len).ok_or(Error::Unmapped { addr })?;
        let (base, (size, device)) = self
            .ranges
            .range(..=addr)
            .next_back()
            .ok_or(Error::Unmapped { addr })?;
        if end <= base + size {
            Ok((*base, device))
        } else {
            Err(Error::Unmapped { addr })
        }
    }
}

/// The x86_64 port I/O bus: `in`/`out` ports mapped to devices.
///
/// Same dispatch rules as [`Bus`], over the separate 16-bit port space that
/// the legacy PC devices (serial, RTC, keyboard controller) occupy. It is a
/// distinct type rather than a generic one because ports are `u16` and fail
/// with port-specific diagnostics.
#[cfg(target_arch = "x86_64")]
#[derive(Default)]
pub struct IoBus {
    /// key: window base port; value: (size, device)
    ranges: BTreeMap<u16, Window>,
}

#[cfg(target_arch = "x86_64")]
impl IoBus {
    /// Creates an empty port bus.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `device` for ports `[base, base + size)`.
    ///
    /// Fails with [`Error::InvalidWindow`] on a zero size or a range that
    /// runs past the end of the 16-bit port space, and with
    /// [`Error::IoOverlap`] if the range touches a registered window;
    /// adjacency is allowed, as on [`Bus`]. One device may own several
    /// windows by registering the same `Arc` once per window, which is how
    /// the i8042 spans non-adjacent ports.
    pub fn insert(
        &mut self,
        base: u16,
        size: u16,
        device: Arc<Mutex<dyn BusDevice + Send>>,
    ) -> Result<()> {
        let wide = u64::from(size);
        if size == 0 || u64::from(base) + wide > 0x1_0000 {
            return Err(Error::InvalidWindow {
                base: u64::from(base),
                size: wide,
            });
        }
        if self.ranges.iter().any(|(old_base, (old_size, _))| {
            overlaps(u64::from(base), wide, u64::from(*old_base), *old_size)
        }) {
            return Err(Error::IoOverlap { port: base, size });
        }
        self.ranges.insert(base, (wide, device));
        Ok(())
    }
    /// Dispatches a guest read from `port` to its device.
    pub fn read(&self, port: u16, data: &mut [u8]) -> Result<()> {
        let (base, device) = self.window(port, data.len() as u64)?;
        let mut guard = device.lock().map_err(|_| Error::DevicePoisoned {
            addr: u64::from(port),
        })?;
        guard.read(u64::from(port) - base, data);
        Ok(())
    }

    /// Dispatches a guest write to `port` to its device.
    pub fn write(&self, port: u16, data: &[u8]) -> Result<()> {
        let (base, device) = self.window(port, data.len() as u64)?;
        let mut guard = device.lock().map_err(|_| Error::DevicePoisoned {
            addr: u64::from(port),
        })?;
        guard.write(u64::from(port) - base, data);
        Ok(())
    }

    /// Finds the window whose ports fully contain `[port, port + len)`.
    ///
    /// As on [`Bus::window`], the greatest base at or below `port` is the
    /// only candidate because windows never overlap. Plain addition is
    /// exact: `insert` confines stored ends to the 16-bit port space plus
    /// one, and an access buffer cannot be long enough to wrap the `u64`
    /// sum.
    fn window(&self, port: u16, len: u64) -> Result<(u64, &Arc<Mutex<dyn BusDevice + Send>>)> {
        let end = u64::from(port) + len;
        let (base, (size, device)) = self
            .ranges
            .range(..=port)
            .next_back()
            .ok_or(Error::IoUnmapped { port })?;
        if end <= u64::from(*base) + *size {
            Ok((u64::from(*base), device))
        } else {
            Err(Error::IoUnmapped { port })
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::PoisonError;

    use super::*;

    /// Echoes `offset + index` on reads so routing tests can identify the window.
    struct Echo;

    impl BusDevice for Echo {
        fn read(&mut self, offset: u64, data: &mut [u8]) {
            for (i, byte) in data.iter_mut().enumerate() {
                *byte = offset as u8 + i as u8;
            }
        }

        fn write(&mut self, _offset: u64, _data: &[u8]) {}
    }

    fn device() -> Arc<Mutex<dyn BusDevice + Send>> {
        Arc::new(Mutex::new(Echo))
    }

    #[test]
    fn insert_rejects_invalid_windows() {
        let mut bus = Bus::new();
        assert!(matches!(
            bus.insert(0x1000, 0, device()),
            Err(Error::InvalidWindow {
                base: 0x1000,
                size: 0
            })
        ));
        // A window that runs past the end of the address space would defeat
        // exact overlap and containment arithmetic: rejected at the boundary.
        assert!(matches!(
            bus.insert(u64::MAX, 2, device()),
            Err(Error::InvalidWindow { .. })
        ));
        // And a re-registration at the same base is still an Overlap, not a
        // silent replacement.
        bus.insert(0x2000, 0x1000, device()).unwrap();
        assert!(matches!(
            bus.insert(0x2000, 0x1000, device()),
            Err(Error::Overlap { .. })
        ));
    }

    #[test]
    fn insert_allows_adjacent_windows() {
        let mut bus = Bus::new();
        bus.insert(0x1000, 2, device()).unwrap();
        bus.insert(0x1002, 2, device()).unwrap();
    }

    #[test]
    fn insert_rejects_overlapping_windows() {
        let mut bus = Bus::new();
        bus.insert(0x1000, 2, device()).unwrap();
        bus.insert(0x1002, 2, device()).unwrap(); // adjacent: allowed
        assert!(matches!(
            bus.insert(0x1003, 2, device()),
            Err(Error::Overlap { .. })
        ));
        assert!(matches!(
            bus.insert(0x0FF0, 0x20, device()),
            Err(Error::Overlap { .. })
        ));
    }

    #[test]
    fn overlap_display_names_the_range() {
        let error = Error::Overlap {
            base: 0xd000_0000,
            size: 0x1000,
        };
        assert_eq!(
            error.to_string(),
            "device at 0xd0000000+4096 overlaps an existing device"
        );
    }

    #[test]
    fn read_write_route_by_address_with_device_offsets() {
        let mut bus = Bus::new();
        bus.insert(0x2000, 0x100, device()).unwrap();
        bus.insert(0x4000, 0x100, device()).unwrap();

        let mut data = [0u8; 4];
        bus.read(0x4010, &mut data).unwrap();
        assert_eq!(data, [0x10, 0x11, 0x12, 0x13]);

        bus.write(0x20f8, &[1, 2, 3, 4]).unwrap();
    }

    #[test]
    fn read_one_byte_past_the_window_end_is_unmapped() {
        let mut bus = Bus::new();
        bus.insert(0x5000, 4, device()).unwrap();
        let mut data = [0u8; 1];
        assert!(matches!(
            bus.read(0x5004, &mut data),
            Err(Error::Unmapped { addr: 0x5004 })
        ));
    }

    #[test]
    fn read_wider_than_the_window_is_unmapped() {
        let mut bus = Bus::new();
        bus.insert(0x6000, 4, device()).unwrap();
        // Starts inside, would spill past the end: no split-access path exists.
        let mut data = [0u8; 4];
        assert!(matches!(
            bus.read(0x6002, &mut data),
            Err(Error::Unmapped { addr: 0x6002 })
        ));
    }

    #[test]
    fn unmapped_display_names_the_address() {
        let error = Error::Unmapped { addr: 0xdead_beef };
        assert_eq!(error.to_string(), "no device at guest address 0xdeadbeef");
    }

    #[test]
    fn write_to_unmapped_reports_unmapped() {
        let bus = Bus::new();
        assert!(matches!(
            bus.write(0x9000, &[1]),
            Err(Error::Unmapped { addr: 0x9000 })
        ));
    }

    #[test]
    fn poisoned_device_reports_instead_of_panic() {
        let mut bus = Bus::new();
        let shared: Arc<Mutex<dyn BusDevice + Send>> = device();
        bus.insert(0x7000, 8, Arc::clone(&shared)).unwrap();

        let poisoner = Arc::clone(&shared);
        let handle = std::thread::spawn(move || {
            let _guard = lock_ok(&poisoner);
            panic!("poison the device lock");
        });
        assert!(handle.join().is_err());

        let mut data = [0u8; 1];
        assert!(matches!(
            bus.read(0x7000, &mut data),
            Err(Error::DevicePoisoned { addr: 0x7000 })
        ));
        assert!(matches!(
            bus.write(0x7000, &[0]),
            Err(Error::DevicePoisoned { addr: 0x7000 })
        ));
    }

    /// Locks without panicking: the poisoning test holds this guard when it panics.
    fn lock_ok<T: BusDevice + Send + ?Sized>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        m.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[test]
    fn poisoned_display_names_the_address() {
        let error = Error::DevicePoisoned { addr: 0x7000 };
        assert_eq!(error.to_string(), "device at 0x7000 is poisoned");
    }

    #[cfg(target_arch = "x86_64")]
    #[test]
    fn io_bus_routes_and_rejects_overlap() {
        let mut bus = IoBus::new();
        bus.insert(0x3F8, 8, device()).unwrap();
        assert!(matches!(
            bus.insert(0x3FD, 8, device()),
            Err(Error::IoOverlap { port: 0x3FD, .. })
        ));
        bus.insert(0x400, 8, device()).unwrap(); // adjacent to 0x3F8+8

        // A 1-byte read at 0x3FD lands at offset 5 of the first window.
        let mut data = [0u8; 1];
        bus.read(0x3FD, &mut data).unwrap();
        assert_eq!(data, [5]);
        bus.write(0x403, &[1]).unwrap();
    }

    #[cfg(target_arch = "x86_64")]
    #[test]
    fn io_bus_reports_unmapped_ports() {
        let mut bus = IoBus::new();
        bus.insert(0x3F8, 8, device()).unwrap();
        // 0x3FF is the last mapped port; 0x400 belongs to nobody.
        let mut data = [0u8; 1];
        bus.read(0x3FF, &mut data).unwrap();
        assert_eq!(data, [7]);
        assert!(matches!(
            bus.read(0x3F7, &mut data),
            Err(Error::IoUnmapped { port: 0x3F7 })
        ));
        assert!(matches!(
            bus.read(0x400, &mut data),
            Err(Error::IoUnmapped { port: 0x400 })
        ));
        assert!(matches!(
            bus.write(0x400, &[0; 4]),
            Err(Error::IoUnmapped { port: 0x400 })
        ));
        // A four-byte access from 0x3FC spills the window: unmapped.
        let mut wide = [0u8; 4];
        assert!(matches!(
            bus.read(0x3FD, &mut wide),
            Err(Error::IoUnmapped { port: 0x3FD })
        ));

        assert_eq!(
            Error::IoOverlap {
                port: 0x60,
                size: 1
            }
            .to_string(),
            "device at port 0x60+1 overlaps an existing device"
        );
        assert_eq!(
            Error::IoUnmapped { port: 0x63 }.to_string(),
            "no device at port 0x63"
        );
    }
}
