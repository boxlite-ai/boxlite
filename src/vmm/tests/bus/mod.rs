// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::sync::{Arc, Mutex};

use boxlite_hypervisor::VcpuExit;

use crate::{
    bus::{Bus, BusDevice, BusRange, Buses},
    error::Error,
};

#[derive(Default)]
struct TestDevice {
    reads: Vec<(u64, usize)>,
    writes: Vec<(u64, Vec<u8>)>,
    read_data: Vec<u8>,
}

impl BusDevice for TestDevice {
    fn read(&mut self, offset: u64, data: &mut [u8]) {
        self.reads.push((offset, data.len()));
        let copy_len = data.len().min(self.read_data.len());
        data[..copy_len].copy_from_slice(&self.read_data[..copy_len]);
    }

    fn write(&mut self, offset: u64, data: &[u8]) {
        self.writes.push((offset, data.to_vec()));
    }
}

#[test]
fn bus_range_rejects_empty_or_wrapping_lengths() {
    assert!(matches!(BusRange::new(0x1000, 0), Err(Error::Overlap)));
    assert!(
        matches!(BusRange::new(u64::MAX, 1), Ok(r) if r.base() == u64::MAX && r.end() == u64::MAX)
    );
    assert!(matches!(BusRange::new(u64::MAX, 2), Err(Error::Overlap)));
    assert!(matches!(
        BusRange::new(u64::MAX - 5, 10),
        Err(Error::Overlap)
    ));
}

#[test]
fn bus_range_detects_overlaps_and_containment() {
    let r = BusRange::new(100, 50).unwrap(); // [100, 149]
    assert_eq!(r.base(), 100);
    assert_eq!(r.len(), 50);
    assert_eq!(r.end(), 149);

    // Overlapping ranges
    assert!(r.overlaps(&BusRange::new(50, 60).unwrap())); // [50, 109]
    assert!(r.overlaps(&BusRange::new(140, 30).unwrap())); // [140, 169]
    assert!(r.overlaps(&BusRange::new(110, 20).unwrap())); // [110, 129]
    assert!(r.overlaps(&BusRange::new(80, 100).unwrap())); // [80, 179]

    // Disjoint / adjacent ranges
    assert!(!r.overlaps(&BusRange::new(50, 50).unwrap())); // [50, 99]
    assert!(!r.overlaps(&BusRange::new(150, 50).unwrap())); // [150, 199]

    // Containment
    assert!(r.contains_range(100, 50));
    assert!(r.contains_range(100, 10));
    assert!(r.contains_range(140, 10));
    assert!(!r.contains_range(99, 10));
    assert!(!r.contains_range(145, 10));
    assert!(!r.contains_range(100, 0));
}

#[test]
fn bus_insert_rejects_overlapping_ranges() {
    let bus = Bus::new();
    let dev1: Arc<Mutex<dyn BusDevice>> = Arc::new(Mutex::new(TestDevice::default()));
    let dev2: Arc<Mutex<dyn BusDevice>> = Arc::new(Mutex::new(TestDevice::default()));

    bus.insert(BusRange::new(0x1000, 0x1000).unwrap(), dev1)
        .expect("insert succeeds");

    // Overlap at start
    assert!(matches!(
        bus.insert(BusRange::new(0x800, 0x1000).unwrap(), dev2.clone()),
        Err(Error::Overlap)
    ));

    // Overlap at end
    assert!(matches!(
        bus.insert(BusRange::new(0x1800, 0x1000).unwrap(), dev2.clone()),
        Err(Error::Overlap)
    ));

    // Fully enclosed
    assert!(matches!(
        bus.insert(BusRange::new(0x1200, 0x100).unwrap(), dev2.clone()),
        Err(Error::Overlap)
    ));

    // Adjacent ranges succeed
    assert!(
        bus.insert(BusRange::new(0x2000, 0x1000).unwrap(), dev2.clone())
            .is_ok()
    );
    assert!(bus.insert(BusRange::new(0, 0x1000).unwrap(), dev2).is_ok());
}

#[test]
fn unclaimed_access_reads_ff_and_drops_writes() {
    let bus = Bus::new();
    let mut buf = [0x55; 4];

    bus.read(0x1000, &mut buf);
    assert_eq!(buf, [0xFF; 4]);

    bus.write(0x1000, &[1, 2, 3, 4]);
}

#[test]
fn partial_access_reads_ff_and_drops_writes() {
    let bus = Bus::new();
    let dev = Arc::new(Mutex::new(TestDevice::default()));
    bus.insert(BusRange::new(0x100, 8).unwrap(), dev.clone())
        .unwrap();

    let mut buf = [0; 4];

    // Starts inside, overflows boundary
    bus.read(0x106, &mut buf);
    assert_eq!(buf, [0xFF; 4]);

    // Starts before range, ends inside
    bus.read(0x0FE, &mut buf);
    assert_eq!(buf, [0xFF; 4]);

    // Overflows on write: dropped
    bus.write(0x106, &[1, 2, 3, 4]);
    assert!(dev.lock().unwrap().writes.is_empty());
}

#[test]
fn dead_weak_reads_ff_and_drops_writes() {
    let bus = Bus::new();
    {
        let dev = Arc::new(Mutex::new(TestDevice::default()));
        bus.insert(BusRange::new(0x100, 8).unwrap(), dev).unwrap();
        // dev is dropped here
    }

    let mut buf = [0; 4];
    bus.read(0x100, &mut buf);
    assert_eq!(buf, [0xFF; 4]);

    bus.write(0x100, &[1, 2, 3, 4]);
}

#[test]
fn zero_fills_buffer_before_device_read_and_passes_relative_offset() {
    let bus = Bus::new();
    let dev = Arc::new(Mutex::new(TestDevice {
        read_data: vec![0x42],
        ..Default::default()
    }));
    bus.insert(BusRange::new(0x1000, 16).unwrap(), dev.clone())
        .unwrap();

    // Buffer has stale data
    let mut buf = [0xAA; 4];
    bus.read(0x1004, &mut buf);

    // Byte 0 written by device (0x42); remaining 3 bytes zero-filled
    assert_eq!(buf, [0x42, 0, 0, 0]);

    let d = dev.lock().unwrap();
    assert_eq!(d.reads, vec![(4, 4)]); // offset 4, len 4
}

#[test]
fn successful_write_delivers_relative_offset_and_data() {
    let bus = Bus::new();
    let dev = Arc::new(Mutex::new(TestDevice::default()));
    bus.insert(BusRange::new(0x2000, 32).unwrap(), dev.clone())
        .unwrap();

    bus.write(0x2008, &[0xDE, 0xAD, 0xBE, 0xEF]);

    let d = dev.lock().unwrap();
    assert_eq!(d.writes, vec![(8, vec![0xDE, 0xAD, 0xBE, 0xEF])]);
}

#[test]
fn buses_dispatch_routes_mmio_and_passes_other_exits() {
    let buses = Buses::new();
    let dev = Arc::new(Mutex::new(TestDevice {
        read_data: vec![0x11, 0x22],
        ..Default::default()
    }));
    buses
        .mmio
        .insert(BusRange::new(0xD000_0000, 0x1000).unwrap(), dev.clone())
        .unwrap();

    let mut read_buf = [0; 2];
    let handled = buses.dispatch(VcpuExit::MmioRead {
        guest_addr: 0xD000_0000,
        bytes: &mut read_buf,
    });
    assert!(handled.is_none());
    assert_eq!(read_buf, [0x11, 0x22]);

    let handled = buses.dispatch(VcpuExit::MmioWrite {
        guest_addr: 0xD000_0004,
        bytes: &[0xAA, 0xBB],
    });
    assert!(handled.is_none());
    assert_eq!(dev.lock().unwrap().writes, vec![(4, vec![0xAA, 0xBB])]);

    // Other exits are returned intact
    let unhandled = buses.dispatch(VcpuExit::Halted);
    assert!(matches!(unhandled, Some(VcpuExit::Halted)));

    let unhandled = buses.dispatch(VcpuExit::Interrupted);
    assert!(matches!(unhandled, Some(VcpuExit::Interrupted)));

    let unhandled = buses.dispatch(VcpuExit::Shutdown);
    assert!(matches!(unhandled, Some(VcpuExit::Shutdown)));

    let unhandled = buses.dispatch(VcpuExit::Reset);
    assert!(matches!(unhandled, Some(VcpuExit::Reset)));
}

#[cfg(target_arch = "x86_64")]
#[test]
fn buses_dispatch_routes_port_io_on_x86_64() {
    let buses = Buses::new();
    let dev = Arc::new(Mutex::new(TestDevice {
        read_data: vec![0x33],
        ..Default::default()
    }));
    buses
        .io
        .insert(BusRange::new(0x3F8, 8).unwrap(), dev.clone())
        .unwrap();

    let mut port_in = [0; 1];
    let handled = buses.dispatch(VcpuExit::IoIn {
        port: 0x3F8,
        bytes: &mut port_in,
    });
    assert!(handled.is_none());
    assert_eq!(port_in, [0x33]);

    let handled = buses.dispatch(VcpuExit::IoOut {
        port: 0x3F8,
        bytes: &[0x77],
    });
    assert!(handled.is_none());
    assert_eq!(dev.lock().unwrap().writes, vec![(0, vec![0x77])]);
}
