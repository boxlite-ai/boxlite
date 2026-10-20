// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Bus ranges, registration and dispatch, driven by a recording device. The
//! range and overlap cases follow Firecracker's `vstate/bus.rs` tests.

use std::{
    error::Error as _,
    panic::{self, AssertUnwindSafe},
    sync::{Arc, Mutex},
};

use boxlite_hypervisor::VcpuExit;

use super::{Bus, BusDevice, BusRange, Buses, UNCLAIMED_READ};
use crate::error::{Error, Result};

/// One access a device saw: whether it was a write, its offset and its bytes.
type Access = (bool, u64, Vec<u8>);

/// Records every access and answers a read by setting only its first byte to
/// `reply`, so a test can see the rest of the buffer arrive zeroed. A write of
/// `PANIC` panics while the device lock is held.
#[derive(Default)]
struct Recorder {
    accesses: Vec<Access>,
    reply: u8,
}

const PANIC: u8 = 0xEE;

impl BusDevice for Recorder {
    fn read(&mut self, offset: u64, data: &mut [u8]) {
        self.accesses.push((false, offset, data.to_vec()));
        if let Some(first) = data.first_mut() {
            *first = self.reply;
        }
    }

    fn write(&mut self, offset: u64, data: &[u8]) {
        self.accesses.push((true, offset, data.to_vec()));
        assert_ne!(data, [PANIC], "the device panics as asked");
    }
}

fn recorder(reply: u8) -> Arc<Mutex<Recorder>> {
    Arc::new(Mutex::new(Recorder {
        reply,
        ..Recorder::default()
    }))
}

fn insert(bus: &mut Bus, base: u64, len: u64, device: &Arc<Mutex<Recorder>>) -> Result<()> {
    let device: Arc<Mutex<dyn BusDevice>> = device.clone();
    bus.insert(BusRange::new(base, len)?, &device)
}

fn accesses(device: &Arc<Mutex<Recorder>>) -> Vec<Access> {
    device.lock().unwrap().accesses.clone()
}

fn assert_overlap(result: Result<()>, base: u64, len: u64) {
    match result {
        Err(Error::Overlap { base: b, len: l }) => assert_eq!((b, l), (base, len)),
        other => panic!("expected Overlap {{ {base:#x}, {len:#x} }}, got {other:?}"),
    }
}

#[test]
fn a_range_is_non_empty_and_does_not_wrap() {
    assert_overlap(BusRange::new(0x10, 0).map(drop), 0x10, 0);
    assert_overlap(BusRange::new(u64::MAX, 2).map(drop), u64::MAX, 2);
    assert_overlap(BusRange::new(2, u64::MAX).map(drop), 2, u64::MAX);
    BusRange::new(u64::MAX, 1).unwrap();
    BusRange::new(0, u64::MAX).unwrap();
    let error = BusRange::new(0x60, 0).unwrap_err();
    assert_eq!(
        error.to_string(),
        "bus range at 0x60 of 0x0 bytes is empty, wraps or overlaps another"
    );
    assert!(error.source().is_none());
}

#[test]
fn insert_rejects_every_overlap_and_accepts_neighbours() {
    let mut bus = Bus::default();
    let device = recorder(0);
    insert(&mut bus, 0x100, 0x10, &device).unwrap();

    for (base, len) in [
        (0x100, 0x10), // the same range
        (0x100, 0x1),  // the same base
        (0xF8, 0x10),  // reaches in from below
        (0x108, 0x10), // reaches out above
        (0xF0, 0x40),  // encloses it
        (0x104, 0x4),  // lies inside it
        (0x10F, 0x1),  // its last address
    ] {
        assert_overlap(insert(&mut bus, base, len, &device), base, len);
    }
    insert(&mut bus, 0xF0, 0x10, &device).unwrap();
    insert(&mut bus, 0x110, 0x10, &device).unwrap();
    insert(&mut bus, u64::MAX, 1, &device).unwrap();
    assert_overlap(insert(&mut bus, 0x118, 0x100, &device), 0x118, 0x100);
}

#[test]
fn accesses_reach_the_device_at_their_offset_with_reads_zeroed() {
    let mut bus = Bus::default();
    let device = recorder(0x60);
    insert(&mut bus, 0x3f8, 8, &device).unwrap();

    bus.write(0x3fb, &[0x80]);
    let mut lsr = [0xAA];
    bus.read(0x3fd, &mut lsr);
    let mut wide = [0xAA; 4];
    bus.read(0x3f8, &mut wide);

    assert_eq!(lsr, [0x60]);
    assert_eq!(wide, [0x60, 0, 0, 0], "bytes the device leaves are zero");
    assert_eq!(
        accesses(&device),
        [
            (true, 3, vec![0x80]),
            (false, 5, vec![0]),
            (false, 0, vec![0; 4]),
        ]
    );
}

#[test]
fn unclaimed_and_partial_accesses_read_all_ones_and_skip_the_device() {
    let mut bus = Bus::default();
    let device = recorder(0x60);
    insert(&mut bus, 0x3f8, 8, &device).unwrap();

    for (addr, len) in [
        (0x2f8, 1), // no device
        (0x3fe, 4), // runs past the range end
        (0x3f7, 2), // starts below the range
        (0x400, 1), // just above the range
        (0x3f8, 0), // empty
    ] {
        let mut data = vec![0x5A; len];
        bus.read(addr, &mut data);
        assert_eq!(data, vec![UNCLAIMED_READ; len], "read {addr:#x}+{len}");
        bus.write(addr, &data);
    }
    assert!(accesses(&device).is_empty());
}

#[test]
fn a_dropped_device_is_unclaimed() {
    let mut bus = Bus::default();
    let device = recorder(0x60);
    insert(&mut bus, 0x70, 2, &device).unwrap();
    drop(device);

    let mut data = [0];
    bus.read(0x70, &mut data);
    bus.write(0x71, &[1]);

    assert_eq!(data, [UNCLAIMED_READ]);
}

/// A device that panicked poisoned its lock; the next access stops as well
/// instead of reading registers the panic left half-written.
#[test]
fn an_access_after_a_device_panicked_stops_too() {
    let mut bus = Bus::default();
    let device = recorder(0x42);
    insert(&mut bus, 0x60, 1, &device).unwrap();

    let first = panic::catch_unwind(AssertUnwindSafe(|| bus.write(0x60, &[PANIC])));
    let second = panic::catch_unwind(AssertUnwindSafe(|| bus.read(0x60, &mut [0])));

    assert!(first.is_err());
    assert!(device.is_poisoned());
    assert!(second.is_err(), "a poisoned device must not answer");
}

#[test]
fn dispatch_serves_io_exits_and_returns_the_rest() {
    let mut buses = Buses::default();
    let mmio = recorder(0x11);
    let mmio_device: Arc<Mutex<dyn BusDevice>> = mmio.clone();
    buses
        .mmio
        .insert(BusRange::new(0x1000, 0x10).unwrap(), &mmio_device)
        .unwrap();

    let mut read = [0; 4];
    assert!(
        buses
            .dispatch(VcpuExit::MmioRead {
                guest_addr: 0x1004,
                bytes: &mut read,
            })
            .is_none()
    );
    assert!(
        buses
            .dispatch(VcpuExit::MmioWrite {
                guest_addr: 0x1008,
                bytes: &[7, 8],
            })
            .is_none()
    );
    assert_eq!(read, [0x11, 0, 0, 0]);
    assert_eq!(
        accesses(&mmio),
        [(false, 4, vec![0; 4]), (true, 8, vec![7, 8])]
    );

    assert!(matches!(
        buses.dispatch(VcpuExit::Interrupted),
        Some(VcpuExit::Interrupted)
    ));
    assert!(matches!(
        buses.dispatch(VcpuExit::Halted),
        Some(VcpuExit::Halted)
    ));
    assert!(matches!(
        buses.dispatch(VcpuExit::Shutdown),
        Some(VcpuExit::Shutdown)
    ));
    assert!(matches!(
        buses.dispatch(VcpuExit::Reset),
        Some(VcpuExit::Reset)
    ));
}

/// Port and MMIO addresses are separate spaces: the same number reaches a
/// different device on each bus.
#[cfg(target_arch = "x86_64")]
#[test]
fn ports_and_mmio_are_separate_address_spaces() {
    let mut buses = Buses::default();
    let mmio = recorder(0x11);
    let pio = recorder(0x22);
    let mmio_device: Arc<Mutex<dyn BusDevice>> = mmio.clone();
    let pio_device: Arc<Mutex<dyn BusDevice>> = pio.clone();
    let range = BusRange::new(0x60, 1).unwrap();
    buses.mmio.insert(range, &mmio_device).unwrap();
    buses.pio.insert(range, &pio_device).unwrap();

    let mut port = [0];
    assert!(
        buses
            .dispatch(VcpuExit::IoIn {
                port: 0x60,
                bytes: &mut port,
            })
            .is_none()
    );
    assert!(
        buses
            .dispatch(VcpuExit::IoOut {
                port: 0x60,
                bytes: &[0xFE],
            })
            .is_none()
    );

    assert_eq!(port, [0x22]);
    assert_eq!(accesses(&pio), [(false, 0, vec![0]), (true, 0, vec![0xFE])]);
    assert!(accesses(&mmio).is_empty());
}

#[test]
fn buses_are_shared_across_vcpu_threads() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Buses>();
}
